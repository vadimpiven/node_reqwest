// SPDX-License-Identifier: Apache-2.0 OR MIT

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { request } from 'undici';
import { afterEach, describe, expect, test } from 'vitest';
import { makeProxyAgent } from './agent-mock.ts';

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
52i+ubtWC9xD4fUetXMaQvZfUGxIL8xXgVxDWKQXfLiG54c8Mp6C7s6xf8kjEUCP
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

describe('ProxyAgent TLS Options', () => {
  let servers: (Server | HttpsServer)[] = [];

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
  });

  test('HTTPS target via HTTP proxy (tunneling)', async () => {
    const targetServer = createHttpsServer({ key, cert }, (_req, res) => {
      res.end('from secured target');
    });
    targetServer.listen(0);
    await once(targetServer, 'listening');
    servers.push(targetServer);
    const targetPort = (targetServer.address() as AddressInfo).port;

    let proxyConnectCalled = false;
    const proxy = createServer();
    proxy.on('connect', (_req, clientSocket: Socket, head) => {
      proxyConnectCalled = true;
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;

    const dispatcher = makeProxyAgent({
      uri: `http://localhost:${proxyPort}`,
      proxyTunnel: true,
      request: {
        rejectUnauthorized: false
        // servername is omitted in TunnelOptions
      }
    });

    const { statusCode, body } = await request(`https://localhost:${targetPort}`, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('from secured target');
    expect(proxyConnectCalled).toBe(true);

    await dispatcher.close();
  });

  test('HTTPS target via HTTPS proxy (double TLS / TLS-in-TLS)', async () => {
    const targetServer = createHttpsServer({ key, cert }, (_req, res) => {
      res.end('from secured target via secured proxy');
    });
    targetServer.listen(0);
    await once(targetServer, 'listening');
    servers.push(targetServer);
    const targetPort = (targetServer.address() as AddressInfo).port;

    let proxySecureConnection = false;
    const proxy = createHttpsServer({ key, cert });
    proxy.on('secureConnection', () => {
      proxySecureConnection = true;
    });
    proxy.on('connect', (_req, clientSocket: Socket, head) => {
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;

    const dispatcher = makeProxyAgent({
      uri: `https://localhost:${proxyPort}`,
      proxyTunnel: true,
      proxy: {
        rejectUnauthorized: false,
        servername: 'localhost'
      },
      request: {
        rejectUnauthorized: false
      }
    });

    const { statusCode, body } = await request(`https://localhost:${targetPort}`, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('from secured target via secured proxy');
    expect(proxySecureConnection).toBe(true);

    await dispatcher.close();
  });

  test('HTTP target via HTTPS proxy', async () => {
    const targetServer = createServer((_req, res) => {
      res.end('from http target via secured proxy');
    });
    targetServer.listen(0);
    await once(targetServer, 'listening');
    servers.push(targetServer);
    const targetPort = (targetServer.address() as AddressInfo).port;

    const proxy = createHttpsServer({ key, cert });
    proxy.on('connect', (_req, clientSocket: Socket, head) => {
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;

    const dispatcher = makeProxyAgent({
      uri: `https://localhost:${proxyPort}`,
      proxyTunnel: true,
      proxy: {
        rejectUnauthorized: false,
        servername: 'localhost'
      }
    });

    const { statusCode, body } = await request(`http://localhost:${targetPort}`, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('from http target via secured proxy');

    await dispatcher.close();
  });

  test('verify proxy and request options are distinct using rejectUnauthorized', async () => {
    const targetServer = createHttpsServer({ key, cert }, (_req, res) => {
      res.end('ok');
    });
    targetServer.listen(0);
    await once(targetServer, 'listening');
    servers.push(targetServer);
    const targetPort = (targetServer.address() as AddressInfo).port;

    const proxy = createHttpsServer({ key, cert });
    proxy.on('connect', (_req, clientSocket, head) => {
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;

    // Case 1: Proxy rejects (no rejectUnauthorized: false in proxy)
    const dispatcher1 = makeProxyAgent({
      uri: `https://localhost:${proxyPort}`,
      proxy: {
        // missing rejectUnauthorized: false
        servername: 'localhost'
      },
      request: {
        rejectUnauthorized: false
      }
    });
    await expect(
      request(`https://localhost:${targetPort}`, { dispatcher: dispatcher1 })
    ).rejects.toThrow();
    await dispatcher1.destroy();

    // Case 2: Target rejects (no rejectUnauthorized: false in request)
    const dispatcher2 = makeProxyAgent({
      uri: `https://localhost:${proxyPort}`,
      proxy: {
        rejectUnauthorized: false,
        servername: 'localhost'
      },
      request: {
        // missing rejectUnauthorized: false
      }
    });
    await expect(
      request(`https://localhost:${targetPort}`, { dispatcher: dispatcher2 })
    ).rejects.toThrow();
    await dispatcher2.destroy();
  });

  test('should support custom CA for proxy and request in ProxyAgent', async () => {
    const targetServer = createHttpsServer({ key, cert }, (_req, res) => {
      res.end('secured via ca');
    });
    targetServer.listen(0);
    await once(targetServer, 'listening');
    servers.push(targetServer);
    const targetPort = (targetServer.address() as AddressInfo).port;

    const proxy = createHttpsServer({ key, cert });
    proxy.on('connect', (_req, clientSocket, head) => {
      const targetSocket = require('node:net').connect(targetPort, 'localhost', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        targetSocket.write(head);
        clientSocket.pipe(targetSocket).pipe(clientSocket);
      });
    });
    proxy.listen(0);
    await once(proxy, 'listening');
    servers.push(proxy);
    const proxyPort = (proxy.address() as AddressInfo).port;

    const dispatcher = makeProxyAgent({
      uri: `https://localhost:${proxyPort}`,
      proxyTunnel: true,
      proxy: {
        ca: cert,
        servername: 'localhost',
        rejectUnauthorized: false
      },
      request: {
        ca: cert,
        rejectUnauthorized: false
      }
    });

    const { statusCode, body } = await request(`https://localhost:${targetPort}`, { dispatcher });
    expect(statusCode).toBe(200);
    expect(await body.text()).toBe('secured via ca');

    await dispatcher.close();
  });
});
