import React from 'react';
import { Image } from 'react-native';

// The Sachiko mark (src/assets/logo/app-logo.svg, rasterised to @1x/2x/3x
// PNGs -- Metro picks the density). `variant="navy"` is the brand original
// for light backgrounds; `variant="white"` recolours the navy shapes to white
// for navy/dark ones (headers), keeping the red so the mark stays recognisable
// rather than flattening into a silhouette.
const SOURCES = {
  navy: require('../assets/logo/logo.png'),
  white: require('../assets/logo/logo-white.png'),
};

export default function AppLogo({ size = 48, variant = 'navy', style }) {
  return (
    <Image
      source={SOURCES[variant] || SOURCES.navy}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="Sachiko logo"
    />
  );
}
