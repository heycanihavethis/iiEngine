const MIN_LEN = 5;
const MAX_TOTAL = 22000;

export async function extractDllStrings(file: File): Promise<{ sha256: string; strings: string }> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const chunks: string[] = [];
  let current = '';
  let total = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const code = buffer[i]!;
    const printable = code >= 32 && code <= 126;
    if (printable) {
      current += String.fromCharCode(code);
      continue;
    }
    if (current.length >= MIN_LEN) {
      chunks.push(current);
      total += current.length + 1;
      if (total >= MAX_TOTAL) break;
    }
    current = '';
  }
  if (current.length >= MIN_LEN && total < MAX_TOTAL) chunks.push(current);

  const interesting = chunks.filter((line) =>
    /https?:|discord|webhook|harmony|bepinex|melon|il2cpp|photon|http|socket|password|token|key|inject|patch/i.test(
      line,
    ),
  );
  const rest = chunks.filter((line) => !interesting.includes(line));
  const ordered = [...interesting, ...rest];
  let out = '';
  for (const line of ordered) {
    if (out.length + line.length + 1 > MAX_TOTAL) break;
    out += `${line}\n`;
  }
  return { sha256, strings: out.trim() || chunks.slice(0, 40).join('\n') };
}
