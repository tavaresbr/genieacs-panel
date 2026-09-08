import http from 'node:http';

/** A parameter node in the shape GenieACS returns. */
function node(value, writable = true) {
  return { _value: value, _writable: writable, _timestamp: '2026-09-01T00:00:00.000Z' };
}

/**
 * A factory ONT with one PPPoE WAN and two WLAN configurations, close enough
 * to a real document that the vendor-aware parameter discovery in
 * `deviceService` takes its normal path.
 */
export function buildDevice({
  id = 'stub-device-1',
  pppoeUsername = 'joao@provedor',
  ssid = 'FACTORY-SSID',
  vlanId = 0,
  tags = []
} = {}) {
  return {
    _id: id,
    _lastInform: new Date().toISOString(),
    _registered: '2026-09-01T00:00:00.000Z',
    _tags: tags,
    _deviceId: {
      _Manufacturer: 'ZTE',
      _ProductClass: 'F670L',
      _SerialNumber: 'ZTEG12345678'
    },
    VirtualParameters: {
      PPPUsername: node(pppoeUsername, false),
      LoginSuperPass: node('factory', true)
    },
    InternetGatewayDevice: {
      DeviceInfo: {
        SoftwareVersion: node('V1.0.0', false),
        SerialNumber: node('ZTEG12345678', false)
      },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: {
              WANPPPConnection: {
                1: {
                  Username: node(pppoeUsername),
                  Password: node(''),
                  Name: node('pppoe_1'),
                  ConnectionStatus: node('Connected', false),
                  NATEnabled: node(true),
                  'X_ZTE-COM_VLANID': node(vlanId),
                  'X_ZTE-COM_ServiceList': node('INTERNET')
                }
              }
            }
          }
        }
      },
      LANDevice: {
        1: {
          WLANConfiguration: {
            1: {
              Enable: node(true),
              SSID: node(ssid),
              BeaconType: node('11i'),
              PreSharedKey: { 1: { KeyPassphrase: node('') } }
            },
            5: {
              Enable: node(true),
              SSID: node(`${ssid}-5G`),
              BeaconType: node('11i'),
              PreSharedKey: { 1: { KeyPassphrase: node('') } }
            }
          }
        }
      }
    }
  };
}

/**
 * Minimal stand-in for a GenieACS NBI. It records every task and tag mutation
 * so a test can assert on what provisioning actually wrote, and `taskStatus`
 * lets a test simulate a CPE that only queues the task (202) rather than
 * applying it.
 */
export function startGenieAcsStub({ devices = [buildDevice()], taskStatus = 200 } = {}) {
  const state = { devices, tasks: [], tags: [], taskStatus };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data ?? null));
      };

      const taskMatch = url.pathname.match(/^\/devices\/([^/]+)\/tasks$/);
      if (taskMatch && req.method === 'POST') {
        let task = null;
        try {
          task = JSON.parse(raw || '{}');
        } catch {
          task = null;
        }
        state.tasks.push({ deviceId: decodeURIComponent(taskMatch[1]), task });
        return send(state.taskStatus, task);
      }

      const tagMatch = url.pathname.match(/^\/devices\/([^/]+)\/tags\/([^/]+)$/);
      if (tagMatch) {
        state.tags.push({
          deviceId: decodeURIComponent(tagMatch[1]),
          tag: decodeURIComponent(tagMatch[2]),
          method: req.method
        });
        return send(200, {});
      }

      if (url.pathname === '/devices' || url.pathname === '/devices/') {
        const query = url.searchParams.get('query');
        if (!query) return send(200, state.devices);
        let filter = {};
        try {
          filter = JSON.parse(query);
        } catch {
          filter = {};
        }
        return send(200, state.devices.filter((device) => !filter._id || device._id === filter._id));
      }

      if (url.pathname === '/faults') return send(200, []);
      return send(404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/** Every parameter path written across the recorded setParameterValues tasks. */
export function writtenParameters(state) {
  return state.tasks
    .filter((entry) => entry.task?.name === 'setParameterValues')
    .flatMap((entry) => entry.task.parameterValues || []);
}
