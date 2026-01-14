export default async function globalSetup(): Promise<void> {
  // When inside the container with MITM proxy enabled,
  // unset all proxy/certificate-related environment variables
  // so they don't interfere with tests
  if (process.env.MITM_PROXY) {
    // Standard proxy variables (both uppercase and lowercase)
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.no_proxy;

    // global-agent proxy settings (used by @electron/get)
    delete process.env.ELECTRON_GET_USE_PROXY;
    delete process.env.GLOBAL_AGENT_HTTP_PROXY;
    delete process.env.GLOBAL_AGENT_HTTPS_PROXY;
    delete process.env.GLOBAL_AGENT_NO_PROXY;

    // Node.js/NPM certificate settings
    delete process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NPM_CONFIG_CAFILE;
    delete process.env.npm_config_cafile;
    delete process.env.pnpm_config_cafile;
  }
}
