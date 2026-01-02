export default async function globalSetup() {
  // When inside the container
  if (process.env.MITM_PROXY) {
    // Clear NODE_EXTRA_CA_CERTS so only system CA store is used
    delete process.env.NODE_EXTRA_CA_CERTS;
  }
}
