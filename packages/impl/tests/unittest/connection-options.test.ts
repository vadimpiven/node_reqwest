// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { errors, request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { makeAgent } from './agent-mock.ts';

// Reuse the same certs as in https.test.ts
const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAyq0DWK7wQ3TQVTR4FwEaUtWY0SBXsmRu6Str6TBLyP9TbLnR
A8Ylz8WIhUN+4GqTl0sAJM1zoD8VBxe9aY5zmLGYLdAopqwym6h+orPRX0LqKtl1
hdn2tyxbSAdAiv3z3J1H43VVsiURVb9P0UkvcHZQP0ZUiRQQvObjsJI5Zm8DFBSW
zHwJQ25QJarJkmipMU2PQt4kM5YYKy6DU+SPRDXH6MxUvqXpl/q8yQs04yw6xazF
ST7Qve2X87NxOBQ4KzBTNjn1EiLpG52unShpTw24ev3XKJKo9soWVfXQz0rAQR2c
ilzGE0Pd1pysPJyPe7F5aWorKdza84VSSHCJowIDAQABAoIBACp+nh4BB/VMz8Wd
q7Q/EfLeQB1Q57JKpoqTBRwueSVai3ZXe4CMEi9/HkG6xiZtkiZ9njkZLq4hq9oB
2z//kzMnwV2RsIRJxI6ohGy+wR51HD4BvEdlTPpY/Yabpqe92VyfSYxidKZWaU0O
QMED1EODOw4ZQ+4928iPrJu//PMB4e7TFao0b9Fk/XLWtu5/tQZz9jsrlTi1zthh
7n+oaGNhfTeIJJL4jrhTrKW1CLHXATtr9SJlfZ3wbMxQVeyj2wUlP1V0M6kBuhNj
tbGbMpixD5iCNJ49Cm2PHg+wBOfS3ADGIpi3PcGw5mb8nB3N9eGBRPhLShAlq5Hi
Lv4tyykCgYEA8u3b3xJ04pxWYN25ou/Sc8xzgDCK4XvDNdHVTuZDjLVA+VTVPzql
lw7VvJArsx47MSPvsaX/+4hQXYtfnR7yJpx6QagvQ+z4ludnIZYrQwdUmb9pFL1s
8UNj+3j9QFRPenIiIQ8qxxNIQ9w2HsVQ8scvc9CjYop/YYAPaQyHaL8CgYEA1ZSz
CR4NcpfgRSILdhb1dLcyw5Qus1VOSAx3DYkhDkMiB8XZwgMdJjwehJo9yaqRCLE8
Sw5znMnkfoZpu7+skrjK0FqmMpXMH9gIszHvFG8wSw/6+2HIWS19/wOu8dh95LuC
0zurMk8rFqxgWMWF20afhgYrUz42cvUTo10FVB0CgYEAt7mW6W3PArfUSCxIwmb4
VmXREKkl0ATHDYQl/Cb//YHzot467TgQll883QB4XF5HzBFurX9rSzO7/BN1e6I0
52i+obtWC9xD4fUetXMaQvZfUGxIL8xXgVxDWKQXfLiG54c8Mp6C7s6xf8kjEUCP
yR1F0SSA/Pzb+8RbY0p7eocCgYA+1rs+SXtHZev0KyoYGnUpW+Uxqd17ofOgOxqj
/t6c5Z+TjeCdtnDTGQkZlo/rT6XQWuUUaDIXxUbW+xEMzj4mBPyXBLS1WWFvVQ5q
OpzO9E/PJeqAH6rkof/aEelc+oc/zvOU1o9uA+D3kMvgEm1psIOq2RHSMhGvDPA0
NmAk+QKBgQCwd1681GagdIYSZUCBecnLtevXmIsJyDW2yR1NNcIe/ukcVQREMDvy
5DDkhnGDgnV1D5gYcXb34g9vYvbfTnBMl/JXmMAAG1kIS+3pvHyN6f1poVe3yJV1
yHVuvymnJxKnyaV0L3ntepVvV0vVNIkA3oauoUTLto6txBI+b/ImDA==
-----END RSA PRIVATE KEY-----`;

const cert = `-----BEGIN CERTIFICATE-----
MIIDhTCCAm2gAwIBAgIJAOrxh0dOYJLdMA0GCSqGSIb3DQEBCwUAMFkxCzAJBgNV
BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX
aWRnaXRzIFB0eSBMdGQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0xNTA5MTkxNDE2
NDRaFw0xNTEwMTkxNDE2NDRaMFkxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21l
LVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQxEjAQBgNV
BAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMqt
A1iu8EN00FU0eBcBGlLVmNEgV7Jkbukra+kwS8j/U2y50QPGJc/FiIVDfuBqk5dL
ACTNc6A/FQcXvWmOc5ixmC3QKKasMpuofqKz0V9C6irZdYXZ9rcsW0gHQIr989yd
R+N1VbIlEVW/T9FJL3B2UD9GVIkUELzm47CSOWZvAxQUlsx8CUNuUCWqyZJoqTFN
j0LeJDOWGCsug1Pkj0Q1x+jMVL6l6Zf6vMkLNOMsOsWsxUk+0L3tl/OzcTgUOCsw
UzY59RIi6Rudrp0oaU8NuHr91yiSqPbKFlX10M9KwEEdnIpcxhND3dacrDycj3ux
eWlqKync2vOFUkhwiaMCAwEAAaNQME4wHQYDVR0OBBYEFA0PN+PGoofZ+QIys2Jy
1Zz94vBOMB8GA1UdIwQYMBaAFA0PN+PGoofZ+QIys2Jy1Zz94vBOMAwGA1UdEwQF
MAMBAf8wDQYJKoZIhvcNAQELBQADggEBAEplethBoPpcP3EbR5Rz6snDDIcbtAJu
Ngd0YZppGT+P0DYnPJva4vRG3bb84ZMSuppz5j67qD6DdWte8UXhK8BzWiHzwmQE
QmbKyzzTMKQgTNFntpx5cgsSvTtrHpNYoMHzHOmyAOboNeM0DWiRXsYLkWTitLTN
qbOpstwPubExbT9lPjLclntShT/lCupt+zsbnrR9YiqlYFY/fDzfAybZhrD5GMBY
XdMPItwAc/sWvH31yztarjkLmld76AGCcO5r8cSR/cX98SicyfjOBbSco8GkjYNY
582gTPkKGYpStuN7GNT5tZmxvMq935HRa2XZvlAIe8ufp8EHVoYiF3c=
-----END CERTIFICATE-----`;

describe('ConnectionOptions coverage', () => {
  let servers: Server[] = [];
  const socketPath = path.join(os.tmpdir(), `undici-test-${Date.now()}.sock`);

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  test('should support socketPath', async () => {
    if (process.platform === 'win32') return;

    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.end('unix ok');
    });
    server.listen(socketPath);
    await once(server, 'listening');
    servers.push(server);

    const dispatcher = makeAgent({
      connect: { socketPath }
    });

    // When socketPath is used, origin must be just the protocol + arbitrary hostname
    const { statusCode, body } = await request('http://localhost', { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('unix ok');
    await dispatcher.close();
  });

  test('should support connection timeout', async () => {
    // We expect ConnectTimeoutError if we use a non-routable IP and short timeout
    const dispatcher = makeAgent({
      connect: { timeout: 1 }
    });

    await expect(
      request('http://10.255.255.1', {
        dispatcher
      })
    ).rejects.toThrow(errors.ConnectTimeoutError);

    await dispatcher.close();
  });

  test('should support custom lookup', async () => {
    let lookupCalled = false;
    const dispatcher = makeAgent({
      connect: {
        lookup: (hostname, _options, callback) => {
          lookupCalled = true;
          if (hostname === 'custom.local') {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          } else {
            callback(new Error('not found'), []);
          }
        }
      }
    });

    const server = createServer((_req, res) => {
      res.end('lookup ok');
    });
    server.listen(0);
    await once(server, 'listening');
    servers.push(server);

    const origin = `http://custom.local:${(server.address() as AddressInfo).port}`;
    const { statusCode } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);
    expect(lookupCalled).toBe(true);
    await dispatcher.close();
  });

  test('should support localAddress', async () => {
    const dispatcher = makeAgent({
      connect: {
        localAddress: '127.0.0.1'
      }
    });

    const server = createServer((_req, res) => {
      res.end('local ok');
    });
    server.listen(0);
    await once(server, 'listening');
    servers.push(server);

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const { statusCode } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);
    await dispatcher.close();
  });

  test('should support mutual TLS (client cert and key)', async () => {
    let clientCertVerified = false;
    const server = createHttpsServer(
      {
        key,
        cert,
        requestCert: true,
        rejectUnauthorized: false
      },
      (req, res) => {
        const peerCert = (req.socket as TLSSocket).getPeerCertificate();
        if (peerCert?.subject) {
          clientCertVerified = true;
        }
        res.end('mtls ok');
      }
    );
    server.listen(0);
    await once(server, 'listening');
    servers.push(server);

    const dispatcher = makeAgent({
      connect: {
        rejectUnauthorized: false,
        key,
        cert
      }
    });

    const origin = `https://localhost:${(server.address() as AddressInfo).port}`;
    const { statusCode } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);
    expect(clientCertVerified).toBe(true);
    await dispatcher.close();
  });

  test('should support keepAliveInitialDelay', async () => {
    const dispatcher = makeAgent({
      connect: {
        keepAliveInitialDelay: 10000
      }
    });

    const server = createServer((_req, res) => {
      res.end('keepalive ok');
    });
    server.listen(0);
    await once(server, 'listening');
    servers.push(server);

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    const { statusCode } = await request(origin, { dispatcher });
    expect(statusCode).toBe(200);
    await dispatcher.close();
  });
});
