import { scrypt, createHash } from "node:crypto";
export function normalizeAnswer(answer: string) {
  return answer
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es");
}
export function codeHash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}
export function answerHash(answer: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      normalizeAnswer(answer),
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
