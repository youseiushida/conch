import { describe, it, expect } from 'vitest';
import { SpecialKeys, getCtrlChar } from '../src/keymap';

describe('Keymap', () => {
  describe('SpecialKeys', () => {
    it('should map common keys correctly', () => {
      expect(SpecialKeys.Enter).toBe('\r');
      expect(SpecialKeys.Backspace).toBe('\x7f');
      expect(SpecialKeys.Tab).toBe('\t');
      expect(SpecialKeys.Escape).toBe('\x1b');
    });

    it('should map arrow keys correctly', () => {
      expect(SpecialKeys.ArrowUp).toBe('\x1b[A');
      expect(SpecialKeys.ArrowDown).toBe('\x1b[B');
      expect(SpecialKeys.ArrowRight).toBe('\x1b[C');
      expect(SpecialKeys.ArrowLeft).toBe('\x1b[D');
    });

    it('should map navigation keys correctly', () => {
      expect(SpecialKeys.Home).toBe('\x1b[H');
      expect(SpecialKeys.End).toBe('\x1b[F');
      expect(SpecialKeys.PageUp).toBe('\x1b[5~');
      expect(SpecialKeys.PageDown).toBe('\x1b[6~');
    });

    it('should map function keys correctly', () => {
      expect(SpecialKeys.F1).toBe('\x1bOP');
      expect(SpecialKeys.F12).toBe('\x1b[24~');
    });
  });

  describe('getCtrlChar', () => {
    it('should convert lowercase letters to control codes', () => {
      expect(getCtrlChar('c')).toBe('\x03'); // ^C
      expect(getCtrlChar('d')).toBe('\x04'); // ^D
      expect(getCtrlChar('z')).toBe('\x1a'); // ^Z
    });

    it('should convert uppercase letters to control codes', () => {
      expect(getCtrlChar('C')).toBe('\x03'); // ^C
      expect(getCtrlChar('D')).toBe('\x04'); // ^D
    });

    it('should handle special control characters', () => {
      expect(getCtrlChar('[')).toBe('\x1b'); // ^[ (Escape)
      expect(getCtrlChar('\\')).toBe('\x1c'); // ^\
    });

    it('should return char as is for non-control characters', () => {
      // Numbers or symbols not in range
      expect(getCtrlChar('1')).toBe('1');
      expect(getCtrlChar('!')).toBe('!');
    });
  });
});
