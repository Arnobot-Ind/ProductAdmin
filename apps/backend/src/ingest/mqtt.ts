/**
 * Optional MQTT transport (enabled when MQTT_BROKER_URL is set). Same pipeline as HTTPS.
 *
 * Topics:  arnobot/v1/{robot_id}/{type}       robot/GCS → PMS (QoS 1)
 *          arnobot/v1/{robot_id}/ack          PMS → sender: { msg_id, status, error? }
 *
 * Authentication happens at the BROKER: each robot/GCS gets broker credentials and an ACL that only
 * lets it publish under its own robot_id(s). The backend then treats the topic's robot_id as
 * the authenticated identity and rejects envelopes whose robot_id differs from the topic.
 */
import mqtt, { type MqttClient } from 'mqtt';
import type { ApiConfig } from '../lib/config';
import type { IngestPipeline } from './pipeline';

const TOPIC = 'arnobot/v1/+/+';
const TOPIC_RE = /^arnobot\/v1\/([a-z][a-z0-9_]*[0-9]+)\/(hello|live|telemetry|event|mission)$/;

export function startMqtt(
  config: ApiConfig['ingest'],
  pipeline: IngestPipeline,
  log: { info: (o: object | string, m?: string) => void; warn: (o: object, m: string) => void },
): MqttClient | null {
  if (!config.mqttUrl) return null;
  const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername ?? undefined,
    password: config.mqttPassword ?? undefined,
    clientId: `pms-backend-${process.pid}`,
    clean: false, // persistent session: QoS1 messages queued while we were down are delivered
    reconnectPeriod: 5_000,
  });
  client.on('connect', () => {
    client.subscribe(TOPIC, { qos: 1 });
    log.info(`mqtt connected, subscribed to ${TOPIC}`);
  });
  client.on('error', (err) => log.warn({ err }, 'mqtt error'));

  // Serialise processing so per-robot ordering (oldest first) is preserved.
  let chain: Promise<unknown> = Promise.resolve();
  client.on('message', (topic, buf) => {
    chain = chain.then(async () => {
      const m = TOPIC_RE.exec(topic);
      if (!m) return;
      const topicRobot = m[1];
      let raw: unknown;
      try {
        raw = JSON.parse(buf.toString('utf8'));
      } catch {
        client.publish(`arnobot/v1/${topicRobot}/ack`, JSON.stringify({ msg_id: null, status: 'rejected', error: 'bad_json' }), { qos: 1 });
        return;
      }
      const identity = { id: null, name: `mqtt:${topicRobot}`, kind: 'robot' as const, keyId: '', robotIds: new Set([topicRobot]) };
      const result = await pipeline.process(raw, identity, 'mqtt');
      client.publish(`arnobot/v1/${topicRobot}/ack`, JSON.stringify(result), { qos: 1 });
    });
  });
  return client;
}
