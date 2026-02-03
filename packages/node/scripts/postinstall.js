// SPDX-License-Identifier: Apache-2.0 OR MIT

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { X509Certificate } from "@sigstore/core";
import { createVerifier, DEFAULT_REKOR_URL } from "sigstore";

/**
 * @typedef {import("@sigstore/bundle").SerializedBundle} SerializedBundle
 * @typedef {import("@sigstore/core").X509Certificate} X509Certificate
 * @typedef {import("@sigstore/rekor-types").LogEntry} LogEntry
 * @typedef {import("@sigstore/rekor-types").DSSEV001Schema} DSSEV001Schema
 * @typedef {import("@sigstore/rekor-types").HashedRekorV001Schema} HashedRekorV001Schema
 */

/**
 * @typedef {Object} NpmAttestation
 * @property {string} predicateType
 * @property {SerializedBundle} bundle
 */

/**
 * @typedef {Object} NpmAttestations
 * @property {NpmAttestation[]} attestations
 */

/**
 * @typedef {Object} RekorEntryBodyDSSE
 * @property {'dsse'} kind
 * @property {DSSEV001Schema} spec
 */

/**
 * @typedef {Object} RekorEntryBodyHashedRekord
 * @property {'hashedrekord'} kind
 * @property {HashedRekorV001Schema} spec
 */

/**
 * @typedef {RekorEntryBodyDSSE | RekorEntryBodyHashedRekord} RekorEntryBody
 */

/**
 * @typedef {Object} TemplateVars
 * @property {string} version
 * @property {string} platform
 * @property {string} arch
 */

/**
 * @typedef {Object} BinaryConfig
 * @property {string} moduleName
 * @property {string} modulePath
 * @property {string} packedName
 * @property {string} remotePath
 */

/**
 * @typedef {Object} PackageJson
 * @property {string} name
 * @property {string} version
 * @property {BinaryConfig} binary
 * @property {string | {url?: string}} repository
 */

// Sigstore Fulcio OID extensions (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md)
const OID_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
const OID_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
const OID_SOURCE_REPO_URI = "1.3.6.1.4.1.57264.1.12";
const OID_RUN_INVOCATION_URI = "1.3.6.1.4.1.57264.1.21";

const NPM_REGISTRY = "https://registry.npmjs.org";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * Extract string value from X509 extension.
 * Handles both v1 (raw ASCII) and v2 (DER-encoded UTF8String) formats.
 * @param {X509Certificate} cert
 * @param {string} oid
 * @returns {string | null}
 */
function getExtensionValue(cert, oid) {
  const ext = cert.extension(oid);
  if (!ext) return null;

  // v2 extensions (1.3.6.1.4.1.57264.1.8+) are DER-encoded UTF8String
  // v1 extensions store raw ASCII in the value
  const subs = ext.valueObj.subs;
  if (subs && subs.length > 0) {
    return subs[0].value.toString("ascii");
  }
  return ext.value.toString("ascii");
}

/**
 * Evaluate template string with variables.
 * @param {string} template
 * @param {TemplateVars} vars
 * @returns {string}
 */
function evalTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/**
 * Fetch npm package attestations from registry.
 * @param {string} packageName
 * @param {string} version
 * @returns {Promise<NpmAttestations>}
 */
async function fetchNpmAttestations(packageName, version) {
  const url = `${NPM_REGISTRY}/-/npm/v1/attestations/${packageName}@${version}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch npm attestations: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Search Rekor transparency log by artifact hash.
 * @param {string} sha256Hash
 * @returns {Promise<string[]>}
 */
async function searchRekor(sha256Hash) {
  const response = await fetch(`${DEFAULT_REKOR_URL}/api/v1/index/retrieve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash: `sha256:${sha256Hash}` }),
  });

  if (!response.ok) {
    throw new Error(`Rekor search failed: ${response.status} ${response.statusText}`);
  }

  const uuids = await response.json();
  if (!uuids || uuids.length === 0) {
    throw new Error(
      `SECURITY: No Rekor entry found for artifact hash ${sha256Hash}. ` +
        "This artifact may have been tampered with or was not built with provenance attestation.",
    );
  }

  return uuids;
}

/**
 * Retrieve entry from Rekor by UUID.
 * @param {string} uuid
 * @returns {Promise<LogEntry>}
 */
async function getRekorEntry(uuid) {
  const response = await fetch(`${DEFAULT_REKOR_URL}/api/v1/log/entries/${uuid}`);
  if (!response.ok) {
    throw new Error(`Failed to retrieve Rekor entry: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Extract certificate from Rekor entry.
 * @param {LogEntry} logEntry
 * @returns {X509Certificate}
 */
function extractCertificateFromLogEntry(logEntry) {
  const entryData = Object.values(logEntry)[0];
  /** @type {RekorEntryBody} */
  const body = JSON.parse(Buffer.from(entryData.body, "base64").toString("utf8"));

  if (body.kind === "dsse") {
    const verifier = body.spec.signatures?.[0]?.verifier;
    if (verifier) {
      return X509Certificate.parse(Buffer.from(verifier, "base64"));
    }
  }

  if (body.kind === "hashedrekord") {
    const content = body.spec.signature.publicKey?.content;
    if (content) {
      return X509Certificate.parse(Buffer.from(content, "base64"));
    }
  }

  throw new Error(`Unsupported Rekor entry type: ${body.kind}`);
}

/**
 * Extract Run Invocation URI from npm provenance attestation.
 * @param {NpmAttestations} attestations
 * @returns {{runInvocationURI: string, bundle: SerializedBundle, cert: X509Certificate}}
 */
function extractRunInvocationURIFromNpmAttestation(attestations) {
  const provenanceAttestation = attestations.attestations.find(
    (a) =>
      a.predicateType === "https://slsa.dev/provenance/v1" ||
      a.predicateType === "https://slsa.dev/provenance/v0.2",
  );

  if (!provenanceAttestation) {
    throw new Error("No SLSA provenance attestation found in npm package");
  }

  const bundle = provenanceAttestation.bundle;
  const certChain = bundle.verificationMaterial?.x509CertificateChain?.certificates;

  if (!certChain || certChain.length === 0) {
    throw new Error("No certificate chain found in npm provenance bundle");
  }

  const cert = X509Certificate.parse(Buffer.from(certChain[0].rawBytes, "base64"));
  const runInvocationURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);

  if (!runInvocationURI) {
    throw new Error("Run Invocation URI not found in npm provenance certificate");
  }

  return { runInvocationURI, bundle, cert };
}

/**
 * Verify certificate is from GitHub Actions and expected repository.
 * @param {X509Certificate} cert
 * @param {string} expectedRepo
 * @returns {void}
 */
function verifyCertificateIdentity(cert, expectedRepo) {
  const issuer = getExtensionValue(cert, OID_ISSUER_V2) || getExtensionValue(cert, OID_ISSUER_V1);

  if (issuer !== GITHUB_ACTIONS_ISSUER) {
    throw new Error(
      "SECURITY: Certificate issuer mismatch.\n" +
        `Expected: ${GITHUB_ACTIONS_ISSUER}\n` +
        `Got: ${issuer}`,
    );
  }

  const sourceRepoURI = getExtensionValue(cert, OID_SOURCE_REPO_URI);
  const expectedRepoURI = `https://github.com/${expectedRepo}`;

  if (sourceRepoURI !== expectedRepoURI) {
    throw new Error(
      "SECURITY: Source repository mismatch.\n" +
        `Expected: ${expectedRepoURI}\n` +
        `Got: ${sourceRepoURI}`,
    );
  }
}

/**
 * Download artifact and compute SHA256 hash.
 * @param {string} url
 * @returns {Promise<{buffer: Buffer, hash: string}>}
 */
async function downloadAndHash(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(buffer).digest("hex");

  return { buffer, hash };
}

/**
 * Main entry point.
 * @returns {Promise<void>}
 */
async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageDir = join(__dirname, "..");

  /** @type {PackageJson} */
  const { name, version, binary, repository } = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );

  // Extract expected repository from package.json
  const repoUrl = typeof repository === "string" ? repository : (repository?.url ?? "");
  const repoMatch = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  const expectedRepo = repoMatch ? repoMatch[1] : null;

  if (!expectedRepo) {
    throw new Error("Could not determine expected repository from package.json");
  }

  /** @type {TemplateVars} */
  const vars = { version, platform: process.platform, arch: process.arch };
  const modulePath = join(packageDir, binary.modulePath);
  const binaryPath = join(modulePath, binary.moduleName);
  const remotePath = evalTemplate(binary.remotePath, vars);
  const packedName = evalTemplate(binary.packedName, vars);
  const downloadUrl = `${remotePath}${packedName}`;

  await mkdir(modulePath, { recursive: true });

  // Skip verification for development version
  if (version === "0.0.0") {
    console.log("[%s] Development version, skipping verification", name);
    return;
  }

  console.log("[%s] Verifying provenance for version %s", name, version);

  // Create sigstore verifier with GitHub Actions issuer requirement
  const verifier = await createVerifier({
    certificateIssuer: GITHUB_ACTIONS_ISSUER,
  });

  // Fetch and verify npm package provenance
  console.log("[%s] Fetching npm package provenance...", name);
  const npmAttestations = await fetchNpmAttestations(name, version);

  const {
    runInvocationURI: npmRunInvocationURI,
    bundle: npmBundle,
    cert: npmCert,
  } = extractRunInvocationURIFromNpmAttestation(npmAttestations);

  console.log("[%s] npm package workflow run: %s", name, npmRunInvocationURI);

  verifyCertificateIdentity(npmCert, expectedRepo);

  console.log("[%s] Verifying npm provenance signature...", name);
  verifier.verify(npmBundle);

  // Download binary and compute hash
  console.log("[%s] Downloading: %s", name, downloadUrl);
  const { buffer: compressedBuffer, hash: artifactHash } = await downloadAndHash(downloadUrl);
  console.log("[%s] Artifact SHA256: %s", name, artifactHash);

  // Search Rekor for binary attestation
  console.log("[%s] Searching Rekor transparency log...", name);
  const rekorUUIDs = await searchRekor(artifactHash);
  console.log("[%s] Found %d Rekor entries", name, rekorUUIDs.length);

  // Find matching Rekor entry from same workflow run
  /** @type {string | null} */
  let binaryRunInvocationURI = null;

  for (const uuid of rekorUUIDs) {
    const logEntry = await getRekorEntry(uuid);
    const cert = extractCertificateFromLogEntry(logEntry);
    const runURI = getExtensionValue(cert, OID_RUN_INVOCATION_URI);

    if (runURI === npmRunInvocationURI) {
      verifyCertificateIdentity(cert, expectedRepo);
      binaryRunInvocationURI = runURI;
      break;
    }
  }

  if (!binaryRunInvocationURI) {
    throw new Error(
      "SECURITY: No Rekor entry found matching the npm package's workflow run.\n" +
        `npm package was built in: ${npmRunInvocationURI}\n` +
        "This binary may have been built in a different workflow run or tampered with.",
    );
  }

  console.log("[%s] Binary workflow run: %s", name, binaryRunInvocationURI);
  console.log("[%s] Workflow runs match!", name);

  // Decompress and write verified binary
  const decompressedBuffer = gunzipSync(compressedBuffer);
  await writeFile(binaryPath, decompressedBuffer, { mode: 0o755 });

  console.log("[%s] Verified and installed: %s", name, binaryPath);
}

process.on("unhandledRejection", (reason) => {
  console.error("Rejection at:", reason);
  process.exit(1);
});

main().catch((err) => {
  console.error("Postinstall failed:", err.message);
  process.exit(1);
});
