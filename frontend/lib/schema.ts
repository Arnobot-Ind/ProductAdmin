/**
 * Runtime values from the shared contract package. Deep-imported so the client bundle pulls
 * only constants + the pure status function (not zod / the message validators).
 */
export {
  CLIENT_CREDENTIAL_KINDS,
  CLIENT_STATUSES,
  CREDENTIAL_KINDS,
  DOCUMENT_TYPES,
  EVENT_SEVERITIES,
  EVENT_TYPES,
  HEALTH_DEVICES,
  LOG_LEVEL_GROUPS,
  MISSION_FILE_KINDS,
  MISSION_STATES,
  PER_CAMERA_CREDENTIAL_KINDS,
  PRODUCT_MEDIA_KINDS,
  RELEASE_COMPONENTS,
  ROBOT_CATEGORIES,
  ROBOT_CATEGORY_LABEL,
  ROBOT_STATUSES,
  SCOPE_TYPES,
  SOFTWARE_KINDS,
  SSH_AUTH_METHODS,
  STATUS_THRESHOLDS,
} from '@arnobot/message-schema/constants';
export { computeRobotStatus } from '@arnobot/message-schema/status';
