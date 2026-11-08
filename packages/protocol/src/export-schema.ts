import { deviceProtocolJsonSchema } from './device.ts';

process.stdout.write(`${JSON.stringify(deviceProtocolJsonSchema(), null, 2)}\n`);
