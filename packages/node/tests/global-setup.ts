export default async function globalSetup() {
  // When inside the container
  if (process.env.MITM_PROXY) {
    // Clear global-agent proxy settings
    delete process.env.ELECTRON_GET_USE_PROXY;
    delete process.env.GLOBAL_AGENT_HTTP_PROXY;
    delete process.env.GLOBAL_AGENT_HTTPS_PROXY;
    delete process.env.GLOBAL_AGENT_NO_PROXY;
    // Clear NODE_EXTRA_CA_CERTS so only system CA store is used
    delete process.env.NODE_EXTRA_CA_CERTS;
  }
}
