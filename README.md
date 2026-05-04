# OpenGarage Garage door

Homebridge plugin for [OpenGarage](https://opengarage.io).
This plugin is a modified version of [homebridge-loxone-garage](https://www.npmjs.com/package/homebridge-loxone-garage)
made to work with OpenGarage.

This repo was forked from https://www.npmjs.com/package/homebridge-og and updated to work with Homebridge v2.

## Requirements

- OpenGarage firmware 1.0.8 or later
- Node.js 18.20.4+ (20, 22, or 24 also supported)
- Homebridge 1.6+ or Homebridge 2.x

## Installation

Install via Homebridge Config UI X (search for `homebridge-og`), or from the command line:

```
npm install -g homebridge-og
```

To install from source:

```
git clone https://github.com/dnsgeek/homebridge-og.git
cd homebridge-og
npm pack
sudo npm install -g homebridge-og-*.tgz
```

## Configuration

Use the Homebridge Config UI X plugin settings page, or edit `config.json` manually.

| Field                   | Required | Default            | Description                                                                                                          |
| ----------------------- | -------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `name`                  | yes      | —                  | Accessory name shown in HomeKit.                                                                                     |
| `ip`                    | yes      | —                  | Hostname or IP address of your OpenGarage device.                                                                    |
| `key`                   | yes      | —                  | Device key (password) configured on the OpenGarage.                                                                  |
| `openCloseDurationSecs` | no       | `25`               | Time within which an open/close transition should reliably complete (and the device will sense the new door state). |
| `pollFrequencySecs`     | no       | `60`               | How often to poll OpenGarage for state changes.                                                                      |
| `vehicleSensorName`     | no       | `Vehicle Present`  | Name of the occupancy sensor exposed for vehicle presence.                                                           |
| `requestTimeoutMs`      | no       | `10000`            | Timeout for HTTP requests to the OpenGarage device.                                                                  |

### Sample config.json

```json
{
  "accessories": [
    {
      "accessory": "OpenGarage",
      "name": "Garage",
      "ip": "192.168.0.4",
      "key": "YourPassword",
      "openCloseDurationSecs": 22,
      "pollFrequencySecs": 60
    }
  ]
}
```

## Notes

1. Set `ip` to the IP or hostname of your OpenGarage device.
2. Set `key` to the device key configured on your OpenGarage.
3. Measure how long it takes for your garage door to close after triggering the state change (including any warning beeps), add a few seconds, and set `openCloseDurationSecs` accordingly.
4. Tell Siri to open or close your garage and receive push notifications on state changes.

## Development

```
npm install
npm test
```
