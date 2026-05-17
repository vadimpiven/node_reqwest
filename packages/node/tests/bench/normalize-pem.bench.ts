// SPDX-License-Identifier: Apache-2.0 OR MIT

import { bench, describe } from "vitest";
import { normalizePem } from "../../export/normalize.ts";

const samplePem = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDU+PQ4F6a9WjANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjQwMTAxMDAwMDAwWhcNMjUwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7
-----END CERTIFICATE-----`;

const samplePemBuffer = Buffer.from(samplePem);

describe("normalizePem", () => {
  bench("undefined input", () => {
    normalizePem();
  });

  bench("single string", () => {
    normalizePem(samplePem);
  });

  bench("single Buffer", () => {
    normalizePem(samplePemBuffer);
  });

  bench("array of strings", () => {
    normalizePem([samplePem, samplePem, samplePem]);
  });

  bench("array of Buffers", () => {
    normalizePem([samplePemBuffer, samplePemBuffer, samplePemBuffer]);
  });

  bench("mixed array", () => {
    normalizePem([samplePem, samplePemBuffer, samplePem, samplePemBuffer]);
  });
});
