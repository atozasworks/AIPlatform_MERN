import { PNG } from 'pngjs';
import fs from 'node:fs';

// 5x7 bitmap font for the letters we need.
const FONT = {
  H: ['10001','10001','11111','10001','10001','10001','10001'],
  E: ['11111','10000','11110','10000','11111','10000','11111'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  W: ['10001','10001','10001','10101','10101','10001','01010'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
};

const text = 'HELLO WORLD';
const scale = 8;
const pad = 40;
const charW = 6 * scale;
const imgW = pad * 2 + text.length * charW;
const imgH = pad * 2 + 7 * scale;

const png = new PNG({ width: imgW, height: imgH });
// white background
for (let y = 0; y < imgH; y++)
  for (let x = 0; x < imgW; x++) {
    const i = (imgW * y + x) * 4;
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
  }

// draw black text
for (let c = 0; c < text.length; c++) {
  const glyph = FONT[text[c]];
  if (!glyph) continue;
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (glyph[row][col] === '1') {
        const x0 = pad + c * charW + col * scale;
        const y0 = pad + row * scale;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const px = x0 + dx, py = y0 + dy;
            if (px < imgW && py < imgH) {
              const i = (imgW * py + px) * 4;
              png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
            }
          }
      }
    }
  }
}

fs.writeFileSync('test-ocr-text.png', PNG.sync.write(png));
console.log('wrote test-ocr-text.png', fs.statSync('test-ocr-text.png').size, 'bytes');
