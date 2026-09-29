/**
 * Runtime values from the shared contract package. Deep-imported so the client bundle pulls
 * only constants + the pure status function (not zod / the message validators).
 */
export {
  CREDENTIAL_KINDS,
  DOCUMENT_TYPES,
  EVENT_SEVERITIES,
  EVENT_TYPES,
  HEALTH_DEVICES,
  MISSION_FILE_KINDS,
  MISSION_STATES,
  PER_CAMERA_CREDENTIAL_KINDS,
  RELEASE_COMPONENTS,
  ROBOT_STATUSES,
  SCOPE_TYPES,
  STATUS_THRESHOLDS,
} from '@arnobot/message-schema/constants';
export { computeRobotStatus } from '@arnobot/message-schema/status';
