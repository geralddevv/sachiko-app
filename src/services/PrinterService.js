import TcpSocket from 'react-native-tcp-socket';
import { NetworkInfo } from 'react-native-network-info';
import {
  CONNECTION_STATUS,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  RECONNECT_DELAYS_MS,
  MAX_RECONNECT_ATTEMPTS,
} from '../constants/printer';

// How long a graceful close is given to flush before the socket is forced
// shut. Only reached when a printer accepts the label but never answers the
// FIN; the normal path closes well inside this.
const GRACEFUL_CLOSE_MS = 2000;

// Floor for how long a single write is given to produce its 'written' ack
// before it is treated as failed. The label itself is a couple of KB, so this
// is really a guard against a socket that has gone away without telling us --
// see the comment in sendCommand().
const MIN_WRITE_ACK_MS = 4000;

// Held after a label's write ack before the socket may be closed, so the last
// label of a batch isn't cut off in the kernel send buffer.
const POST_WRITE_SETTLE_MS = 200;

class PrinterServiceClass {
  constructor() {
    this.socket = null;
    this.status = CONNECTION_STATUS.DISCONNECTED;
    this.ip = null;
    this.port = DEFAULT_PORT;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
    this.autoReconnect = false;
    this.lastError = null;
    this.lastCommunicationAt = null;
    this.lastResponse = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.manualDisconnect = false;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState() {
    return {
      status: this.status,
      ip: this.ip,
      port: this.port,
      lastError: this.lastError,
      lastCommunicationAt: this.lastCommunicationAt,
      lastResponse: this.lastResponse,
      autoReconnect: this.autoReconnect,
    };
  }

  _notify() {
    const state = this.getState();
    this.listeners.forEach(listener => listener(state));
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this._notify();
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connectPrinter(this.ip, this.port, {
        timeoutMs: this.timeoutMs,
        autoReconnect: this.autoReconnect,
      }).catch(() => {
        // Failure already reflected in status; _scheduleReconnect will be
        // retried from the resulting 'close' event if attempts remain.
      });
    }, delay);
  }

  async connectPrinter(ip, port = DEFAULT_PORT, { timeoutMs = DEFAULT_TIMEOUT_MS, autoReconnect = false } = {}) {
    // Close whatever is already open FIRST. These print servers accept a
    // single session at a time, so opening a second socket while the first is
    // still held is refused outright -- and because this used to overwrite
    // this.socket without closing it, the orphaned socket went on occupying
    // the printer with nothing left holding a reference to it. Pressing
    // "Connect" on the Printer Settings screen (which deliberately keeps a
    // connection open) was therefore enough to make every subsequent print
    // fail with "could not reach the printer", while the printer itself was
    // perfectly healthy -- it was answering us and refusing everyone else.
    //
    // Awaited: the close has to have completed before the new connection is
    // attempted, or it races the very session it is trying to free.
    if (this.socket) {
      await this.disconnectPrinter();
    }
    this.manualDisconnect = false;
    this._clearReconnectTimer();
    this.ip = ip;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.autoReconnect = autoReconnect;
    this._setStatus(CONNECTION_STATUS.CONNECTING, { lastError: null });

    return new Promise((resolve, reject) => {
      let settled = false;

      const timeoutTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.socket?.destroy();
        this.socket = null;
        this._setStatus(CONNECTION_STATUS.ERROR, { lastError: 'Connection timed out' });
        reject(new Error('Connection timed out'));
      }, timeoutMs);

      let socket;
      try {
        socket = TcpSocket.createConnection({ port, host: ip, reuseAddress: true }, () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutTimer);
          this.socket = socket;
          this.reconnectAttempt = 0;
          this._setStatus(CONNECTION_STATUS.CONNECTED, {
            lastError: null,
            lastCommunicationAt: Date.now(),
          });
          resolve();
        });
      } catch (error) {
        clearTimeout(timeoutTimer);
        this._setStatus(CONNECTION_STATUS.ERROR, { lastError: error.message });
        reject(error);
        return;
      }

      // Every handler below belongs to THIS socket, and each print opens a new
      // one. Without the identity check a previous socket finishing its close
      // would reach in and clear the connection that replaced it: print #1
      // ends, print #2 connects, then #1's late 'close' nulls this.socket and
      // flips the status to DISCONNECTED, so #2's write is rejected with
      // "Printer not connected". That is exactly the "first label prints, the
      // rest don't" symptom -- and it only became reachable once disconnect
      // started closing gracefully, because destroy() used to fire 'close'
      // almost instantly.
      const isCurrent = () => this.socket === socket;

      socket.on('error', error => {
        const message = error?.message ?? String(error);
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          this._setStatus(CONNECTION_STATUS.ERROR, { lastError: message });
          reject(error);
          return;
        }
        if (!isCurrent()) {
          return;
        }
        this.lastError = message;
        this._notify();
      });

      socket.on('data', data => {
        if (!isCurrent()) {
          return;
        }
        this.lastCommunicationAt = Date.now();
        this.lastResponse = data?.toString?.('utf8') ?? String(data);
        this._notify();
      });

      socket.on('close', () => {
        // A socket this service has already let go of. disconnectPrinter()
        // has set the status itself; touching it here would undo a newer
        // connection.
        if (!isCurrent()) {
          return;
        }
        this.socket = null;
        this._setStatus(CONNECTION_STATUS.DISCONNECTED);
        if (!this.manualDisconnect && this.autoReconnect) {
          this._scheduleReconnect();
        }
      });
    });
  }

  disconnectPrinter() {
    this.manualDisconnect = true;
    this._clearReconnectTimer();
    this.reconnectAttempt = 0;
    if (this.socket) {
      // end(), not destroy(). destroy() cuts the connection immediately and
      // discards anything the OS still has buffered -- which, on a label sent
      // milliseconds earlier, is the label. end() sends a FIN, so the send
      // buffer is flushed to the printer before the socket closes.
      const socket = this.socket;
      this.socket = null;
      this._setStatus(CONNECTION_STATUS.DISCONNECTED);
      // Resolves once the socket is genuinely closed. Callers await it before
      // starting the next label: most label printers accept a single
      // connection on port 9100, so opening the next one while this is still
      // shutting down gets refused.
      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(forceTimer);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          // A printer that never answers the FIN would leave this half-open
          // forever, so give the flush a moment and then force it.
          try {
            socket.destroy();
          } catch (error) {
            // Already closed.
          }
          finish();
        }, GRACEFUL_CLOSE_MS);
        try {
          socket.once('close', finish);
        } catch (error) {
          // No emitter on this socket; the timer above is the fallback.
        }
        try {
          socket.end();
        } catch (error) {
          try {
            socket.destroy();
          } catch (destroyError) {
            // Already gone.
          }
          finish();
        }
      });
    }
    this._setStatus(CONNECTION_STATUS.DISCONNECTED);
    return Promise.resolve();
  }

  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.status !== CONNECTION_STATUS.CONNECTED) {
        reject(new Error('Printer not connected'));
        return;
      }

      const socket = this.socket;
      let settled = false;

      // The 'written' ack is the ONLY confirmation the bytes left the device
      // (RN's TcpSockets.write() returns straight away and surfaces the ack
      // through this callback -- see react-native-tcp-socket/src/Socket.js).
      // But nothing guarantees the ack ever arrives: a half-open socket -- the
      // printer unplugged mid-session, Wi-Fi dropped without a FIN, the print
      // server hung -- swallows the write with neither ack nor error. Without
      // this timer that promise never settles, and because printQueue holds
      // `flushing` for the whole drain, one stuck write freezes every pending
      // label until the app is killed. Bound it, and treat the timeout as a
      // failed send: the label stays queued and is retried on a fresh socket.
      const ackTimeoutMs = Math.max(this.timeoutMs || 0, MIN_WRITE_ACK_MS);
      let ackTimer = null;
      const finish = error => {
        if (settled) {
          return;
        }
        settled = true;
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
        if (error) {
          // The socket is unusable now; drop it so the next label opens a new
          // one instead of writing into a dead connection.
          if (this.socket === socket) {
            this.socket = null;
          }
          try {
            socket.destroy();
          } catch (destroyError) {
            // Already gone.
          }
          this._setStatus(CONNECTION_STATUS.ERROR, {
            lastError: error.message || String(error),
          });
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.lastCommunicationAt = Date.now();
        this._notify();
        resolve();
      };

      ackTimer = setTimeout(
        () => finish(new Error('Printer did not acknowledge the label')),
        ackTimeoutMs,
      );

      try {
        // Resolving without waiting for the ack meant printLabel() reported
        // success before anything had been sent, and the disconnectPrinter()
        // that every caller runs next tore the socket down with the label
        // still queued -- so the printer connected, raised no error, and
        // printed nothing at all.
        socket.write(command, 'utf8', error => finish(error || null));
      } catch (error) {
        finish(error);
      }
    });
  }

  async printLabel(tsplCommand) {
    await this.sendCommand(tsplCommand);
    // The 'written' ack means "handed to the OS", not "on the wire". Give the
    // kernel a beat to push it out before the caller closes the socket --
    // disconnectPrinter() flushes on end(), but this removes any doubt for the
    // last label of a drain, which is the one that goes missing.
    await new Promise(resolve => setTimeout(resolve, POST_WRITE_SETTLE_MS));
  }

  async printMultiple(tsplCommands) {
    for (const command of tsplCommands) {
      await this.printLabel(command);
    }
  }

  testConnection(ip, port = DEFAULT_PORT, timeoutMs = 3000) {
    return new Promise(resolve => {
      let settled = false;
      let socket;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket?.destroy();
        resolve({ ok: false, error: 'Connection timed out' });
      }, timeoutMs);

      try {
        socket = TcpSocket.createConnection({ port, host: ip, reuseAddress: true }, () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve({ ok: true });
        });
        socket.on('error', error => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: error?.message ?? String(error) });
        });
      } catch (error) {
        clearTimeout(timer);
        resolve({ ok: false, error: error.message });
      }
    });
  }

  ping(timeoutMs = 3000) {
    if (!this.ip) {
      return Promise.resolve({ ok: false, error: 'No printer configured' });
    }
    const startedAt = Date.now();
    return this.testConnection(this.ip, this.port, timeoutMs).then(result => ({
      ...result,
      latencyMs: result.ok ? Date.now() - startedAt : null,
    }));
  }

  async getSubnetPrefix() {
    const ip = await NetworkInfo.getIPV4Address();
    if (!ip) {
      return null;
    }
    const parts = ip.split('.');
    return parts.length === 4 ? parts.slice(0, 3).join('.') : null;
  }

  async scanNetwork({ prefix, port = DEFAULT_PORT, timeoutMs = 400, concurrency = 24, onProgress, onFound } = {}) {
    const subnet = prefix ?? (await this.getSubnetPrefix());
    if (!subnet) {
      throw new Error('Could not determine local Wi-Fi network');
    }
    const hosts = Array.from({ length: 254 }, (_, index) => `${subnet}.${index + 1}`);
    const found = [];
    let scanned = 0;

    for (let i = 0; i < hosts.length; i += concurrency) {
      const batch = hosts.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async host => {
          const result = await this.testConnection(host, port, timeoutMs);
          scanned += 1;
          onProgress?.(scanned, hosts.length);
          if (result.ok) {
            found.push(host);
            onFound?.(host);
          }
        }),
      );
    }

    return found;
  }
}

export const PrinterService = new PrinterServiceClass();
