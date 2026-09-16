import React from 'react';
import { Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { colors, radii, spacing, fontFamily } from '../theme/theme';

// A last-resort net so an unexpected render error surfaces a readable message
// instead of hard-closing the app (release builds have no dev red-box: an
// uncaught render error otherwise just kills the process). "Try again" clears
// the error and re-renders the tree.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message}>{String(error?.message || error)}</Text>
        <TouchableOpacity style={styles.button} onPress={() => this.setState({ error: null })}>
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>If this keeps happening, let your admin know.</Text>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  title: { fontSize: 18, fontWeight: '700', color: colors.textDark, marginBottom: spacing.sm, fontFamily },
  message: { fontSize: 13.5, color: colors.dangerStrong, textAlign: 'center', marginBottom: spacing.lg, fontFamily },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15, fontFamily },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: spacing.lg, textAlign: 'center', fontFamily },
});
