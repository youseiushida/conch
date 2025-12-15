export const SpecialKeys: { [key: string]: string } = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  
  // Cursor
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  
  // Navigation
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  
  // Function Keys (Standard xterm)
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

// Helper to convert Control+Char to ASCII
// e.g. 'c' -> '\x03'
export function getCtrlChar(char: string): string {
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) { // @, A-Z, [, \, ], ^, _
    return String.fromCharCode(code - 64);
  }
  return char; // Fallback
}
