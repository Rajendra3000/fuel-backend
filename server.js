const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const OCR_API_KEY = process.env.OCR_API_KEY;

// Nozzle No1 = MS, Nozzle No2 = HSD
const DU_NOZZLE_MAP = {
  DU1: { 1: 'ms', 2: 'hsd' },
  DU2: { 1: 'ms', 2: 'hsd' }
};

app.post('/scan', async (req, res) => {
  try {
    const { imageBase64, mimeType, du } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    async function runOCR(engine) {
      const r = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apikey: OCR_API_KEY,
          base64Image: `data:image/jpeg;base64,${imageBase64}`,
          language: 'eng',
          isOverlayRequired: false,
          detectOrientation: true,
          scale: true,
          OCREngine: engine
        })
      });
      const d = await r.json();
      if (d.IsErroredOnProcessing) throw new Error(d.ErrorMessage?.[0] || 'OCR error');
      return d.ParsedResults?.[0]?.ParsedText || '';
    }

    // Try engine 2 first, fallback to engine 1
    let fullText = await runOCR(2);
    if (!fullText || fullText.trim().length < 20) fullText = await runOCR(1);
    console.log('RAW OCR:\n', fullText);

    // Normalize common OCR errors in receipt text
    let text = fullText
      .replace(/CumVo\s*lume/gi, 'CumVolume')   // "CumVo lume" → "CumVolume"
      .replace(/Cum\s*Vol\s*ume/gi, 'CumVolume') // any spacing variant
      .replace(/Cum\s*V[o0]l[^u]/gi, (m) => 'CumVolume' + m.slice(-1)) // CumVol followed by non-u
      .replace(/No2z\s*le|N[o0]z\s*zle|N[o0]zzle/gi, 'Nozzle')  // garbled Nozzle
      .replace(/N[o0]\]/gi, 'No1')               // "No]" → "No1"
      .replace(/No\s*\]/gi, 'No1');

    console.log('NORMALIZED:\n', text);

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let ms = null, hsd = null;

    // Find largest number at or after line index (for wrapped values)
    function findNumberFrom(idx) {
      for (let j = idx; j < Math.min(idx + 4, lines.length); j++) {
        // Match numbers with 3+ digits before decimal
        const nums = lines[j].match(/\d{3,}\.?\d*/g);
        if (nums) {
          // Pick the largest (CumVolume is always the biggest number on slip)
          const parsed = nums.map(Number);
          return Math.max(...parsed);
        }
      }
      return null;
    }

    // Strategy 1: Nozzle-based parsing
    const nozzleCumVol = {};
    let currentNozzle = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match nozzle lines: "Nozzle No1", "Nozzle No 2", "Nozzle1" etc
      const nm = line.match(/nozzle\s*[Nn]?[o0]\.?\s*(\d+)/i)
                || line.match(/nozzle\s*(\d+)/i);
      if (nm) {
        currentNozzle = parseInt(nm[1]);
        console.log(`Found nozzle ${currentNozzle} at line ${i}: "${line}"`);
        continue;
      }

      // Match CumVolume line (after normalization)
      if (currentNozzle !== null && /cumvolume/i.test(line) && !(currentNozzle in nozzleCumVol)) {
        const val = findNumberFrom(i);
        if (val !== null) {
          nozzleCumVol[currentNozzle] = val;
          console.log(`Nozzle ${currentNozzle} CumVolume = ${val}`);
        }
      }
    }

    // Map nozzles to products
    if (Object.keys(nozzleCumVol).length) {
      const map = DU_NOZZLE_MAP[du] || { 1: 'ms', 2: 'hsd' };
      for (const [n, val] of Object.entries(nozzleCumVol)) {
        const product = map[Number(n)];
        if (product === 'ms' && ms === null) ms = val;
        if (product === 'hsd' && hsd === null) hsd = val;
      }
    }

    // Strategy 2: Fallback — grab all CumVolume values in order
    if (ms === null || hsd === null) {
      console.log('Falling back to sequential CumVolume search...');
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/cumvolume|cum\s*vol/i.test(lines[i])) {
          const val = findNumberFrom(i);
          if (val) {
            count++;
            console.log(`Sequential CumVol #${count} = ${val}`);
            if (count === 1 && ms === null) ms = val;
            else if (count === 2 && hsd === null) hsd = val;
          }
        }
      }
    }

    console.log(`FINAL — MS: ${ms}, HSD: ${hsd}`);
    res.json({ ms: ms ?? null, hsd: hsd ?? null, rawText: fullText });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Fuel Sales Tracker API running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
