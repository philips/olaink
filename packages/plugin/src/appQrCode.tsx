import React from 'react';
import { View } from 'react-native';

/**
 * QR code for https://app.olaink.com, drawn with plain Views (no QR or SVG dependency in
 * the plugin). The module grid is fixed data for this one URL, generated with
 * qrcode@1.5.4 (error correction M, version 2, 25x25):
 *   QRCode.create('https://app.olaink.com', { errorCorrectionLevel: 'M' })
 * Regenerate it if APP_URL ever changes.
 */
export const APP_URL = 'https://app.olaink.com';

const MODULES = [
  '1111111000000100101111111',
  '1000001001011101001000001',
  '1011101010111010101011101',
  '1011101010110100001011101',
  '1011101010100100101011101',
  '1000001011000111101000001',
  '1111111010101010101111111',
  '0000000011100001000000000',
  '1011111001111110001111100',
  '0110000101001000110100010',
  '1011101111110101101101011',
  '0000010110101011001000001',
  '1001111001000111011010111',
  '1101110110001100110101010',
  '1001011100000111001111011',
  '1010010111101011101110001',
  '1010101001001110111110100',
  '0000000011000101100011000',
  '1111111000011010101010111',
  '1000001010110010100011000',
  '1011101010110001111110111',
  '1011101010001100101011111',
  '1011101010000110100001101',
  '1000001000101101110111001',
  '1111111010101010000111111',
];

/** Quiet zone of 4 modules on every side, as the QR spec requires. */
const QUIET = 4;

export function AppQrCode({ moduleSize = 8 }: { moduleSize?: number }) {
  const side = (MODULES.length + QUIET * 2) * moduleSize;
  return <View accessibilityLabel={`QR code for $https://app.olaink.com`}
    style={{ width: side, height: side, padding: QUIET * moduleSize, backgroundColor: '#fff' }}>
    {MODULES.map((row, y) => <View key={y} style={{ flexDirection: 'row', height: moduleSize }}>
      {runs(row).map(([dark, length], x) => <View key={x}
        style={{ width: length * moduleSize, height: moduleSize, backgroundColor: dark ? '#000' : '#fff' }} />)}
    </View>)}
  </View>;
}

/** Collapses a row into [dark, length] runs so each row is a handful of Views. */
function runs(row: string): [boolean, number][] {
  const result: [boolean, number][] = [];
  for (const cell of row) {
    const dark = cell === '1';
    const last = result[result.length - 1];
    if (last && last[0] === dark) last[1] += 1;
    else result.push([dark, 1]);
  }
  return result;
}
