// Client-minted idempotency token for one Production Log row -- ported
// verbatim from jobCardForm.ejs's own fallback generator (SACHIKO2), not
// crypto.randomUUID(): RN/Hermes has no guaranteed randomUUID() and neither
// app bundles a uuid polyfill, so this is the one generator both the web
// form and this app actually rely on. Minted once per row on creation,
// carried through both the instant-produce call (POST /jobcard/log/produce,
// fired the moment Stop is punched) and the row's own fields on the final
// job-card save -- see MaterialStock.productionRowToken on the server for
// how it's matched back to a Deckle already inwarded.
export function newRowToken() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
