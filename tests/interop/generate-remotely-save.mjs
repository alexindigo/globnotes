// SPDX-License-Identifier: LGPL-3.0-only
// Reference generation only: unchanged pinned upstream algorithms plus imports
// and browser-runtime shims. Nothing from these downloads ships in the plugin.
const revision = "34db181af002f8d71ea0a87e7965abc57b294914";
const rcloneRevision = "fe7ce657bcf92566986ed1572f90e1cbb4683464";
const args = Deno.args;
const arg = (flag) => args[args.indexOf(flag) + 1];
if (arg("--revision") !== revision) {
  throw Error("Expected pinned Remotely Save revision");
}
const checking = args.includes("--check");
const destination = arg(checking ? "--check" : "--write");
if (!destination) throw Error("Use --check DIR or --write DIR");
const scratch = await Deno.makeTempDir({
  dir: "/artifacts",
  prefix: "reference-",
});
const digest = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
const base64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
};
const sources = [];
async function download(url, name) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Source download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Deno.writeFile(`${scratch}/${name}.original`, bytes);
  sources.push({ url, sha256: await digest(bytes) });
  return new TextDecoder().decode(bytes);
}
const imports = {
  "rfc4648": "npm:rfc4648@1.5.4",
  "@noble/hashes/scrypt": "npm:@noble/hashes@1.8.0/scrypt",
  "@noble/ciphers/salsa": "npm:@noble/ciphers@0.5.3/salsa",
  "@noble/ciphers/webcrypto": "npm:@noble/ciphers@0.5.3/webcrypto",
  "pkcs7-padding": "npm:pkcs7-padding@0.1.1",
  "@fyears/eme": "npm:@fyears/eme@0.0.3",
  "base32768": "npm:base32768@3.0.1",
};
function shimImports(source) {
  for (const [name, specifier] of Object.entries(imports)) {
    source = source.replaceAll(`from "${name}"`, `from "${specifier}"`);
  }
  return source;
}
let opensslSource = await download(
  `https://raw.githubusercontent.com/remotely-save/remotely-save/${revision}/src/encryptOpenSSL.ts`,
  "encryptOpenSSL.ts",
);
opensslSource = shimImports(opensslSource).replace(
  'from "./misc"',
  'from "./misc.ts"',
);
await Deno.writeTextFile(`${scratch}/encryptOpenSSL.ts`, opensslSource);
await Deno.writeTextFile(
  `${scratch}/misc.ts`,
  `export const bufferToArrayBuffer = (bytes:Uint8Array) => bytes.slice().buffer; export const hexStringToTypedArray = (hex:string) => Uint8Array.from(hex.match(/../g)!, x=>parseInt(x,16));`,
);
const rcloneSource = await download(
  `https://raw.githubusercontent.com/fyears/rclone-crypt/${rcloneRevision}/src/index.ts`,
  "rclone.ts",
);
await Deno.writeTextFile(`${scratch}/rclone.ts`, shimImports(rcloneSource));
globalThis.window = { crypto: globalThis.crypto };
const openssl = await import(`file://${scratch}/encryptOpenSSL.ts`);
const { Cipher } = await import(`file://${scratch}/rclone.ts`);
const password = "reference-only-password-\u00e9";
const cipher = new Cipher("base64");
await cipher.key(password, "");
const { createCodec } = await import(
  "../../plugins/globnotes-remotely-save/crypto.js"
);
const productOpenSSL = await createCodec("openssl-base64", password);
const productRclone = await createCodec("rclone-base64", password);
const saltHex = "0001020304050607";
const nonce = Uint8Array.from({ length: 24 }, (_, i) => i === 0 ? 255 : i);
const names = [];
for (
  const path of [
    "A.md",
    "folder/Unicode-\u00e9-\ud83c\udf0d.md",
    "folder/",
    "_remotely-save-metadata-on-remote.json",
    "_remotely-save-metadata-on-remote.bin",
  ]
) {
  names.push({
    path,
    openssl64: await openssl.encryptStringToBase64url(
      path,
      password,
      20000,
      saltHex,
    ),
    openssl32: await openssl.encryptStringToBase32(
      path,
      password,
      20000,
      saltHex,
    ),
    rclone: await cipher.encryptFileName(path),
  });
}
const bodies = [];
for (const length of [0, 1, 15, 16, 17, 65535, 65536, 65537]) {
  const plain = Uint8Array.from({ length }, (_, i) => i % 251);
  const openWire = new Uint8Array(
    await openssl.encryptArrayBuffer(plain.buffer, password, 20000, saltHex),
  );
  const cloneWire = await cipher.encryptData(plain, nonce.slice());
  const productOpenWire = await productOpenSSL.encrypt(
    plain,
    Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
  );
  const productCloneWire = await productRclone.encrypt(plain, nonce);
  if (
    await digest(
      new Uint8Array(
        await openssl.decryptArrayBuffer(productOpenWire.buffer, password),
      ),
    ) !== await digest(plain)
  ) throw Error("upstream cannot consume driver OpenSSL output");
  if (
    await digest(await cipher.decryptData(productCloneWire)) !==
      await digest(plain)
  ) throw Error("upstream cannot consume driver rclone output");
  // Assert both upstream decrypt consumers, not just their encryption outputs.
  if (
    await digest(
      new Uint8Array(
        await openssl.decryptArrayBuffer(openWire.buffer, password),
      ),
    ) !== await digest(plain)
  ) throw Error("upstream OpenSSL read");
  if (
    await digest(await cipher.decryptData(cloneWire)) !== await digest(plain)
  ) throw Error("upstream rclone read");
  bodies.push({
    length,
    plainSha256: await digest(plain),
    openssl: base64(openWire),
    rclone: base64(cloneWire),
  });
}
const legacy = {
  version: "20220220",
  generatedWhen: 1,
  deletions: [{ key: "deleted.md", actionWhen: 1 }],
};
const legacyMetadata = JSON.stringify({
  readme: "legacy fixture; not v3 deletion authority",
  d: base64(new TextEncoder().encode(JSON.stringify(legacy))).replaceAll(
    "+",
    "-",
  ).replaceAll("/", "_").replace(/=+$/, "").split("").reverse().join(""),
});
const output = JSON.stringify(
  {
    revision,
    rcloneRevision,
    sources,
    password,
    saltHex,
    nonce: Array.from(nonce),
    names,
    bodies,
    legacyMetadata,
  },
  null,
  2,
) + "\n";
productOpenSSL.close();
productRclone.close();
await Deno.mkdir(destination, { recursive: true });
const filename = `${destination}/vectors.json`;
if (checking) {
  if (await Deno.readTextFile(filename) !== output) {
    throw Error("Reference fixture drift");
  }
} else {
  await Deno.writeTextFile(filename, output);
}
await Deno.writeTextFile(
  `${scratch}/provenance.json`,
  JSON.stringify(
    { sources, fixtureSha256: await digest(new TextEncoder().encode(output)) },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    checking,
    filename,
    scratch,
    sources,
    fixtureSha256: await digest(new TextEncoder().encode(output)),
  }),
);
