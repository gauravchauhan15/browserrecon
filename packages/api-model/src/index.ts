/**
 * @browserrecon/api-model — context-aware API objects.
 *
 * Consumes a recorded event log and produces the §23.2 objects: identity and
 * dedup, initiator chains, typed causality, and payload shapes. Runs with no
 * browser present, which is §1.2's load-bearing rule.
 */
export const PACKAGE_NAME = "@browserrecon/api-model" as const;

export { ParameterTally, apiIdentity, isSensitiveParameterName } from "./identity.js";
export type { ApiIdentity, ObservedParameter } from "./identity.js";

export { ShapeBuilder, isSensitiveFieldName } from "./payload.js";
export type { FieldShape, FieldType, PayloadShape } from "./payload.js";

export {
  OBSERVED_KINDS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_STRENGTH,
  buildInitiatorChain,
  edgeFromInitiator,
  parseFrame,
  reduceRelationships,
} from "./relationships.js";
export type {
  InitiatorChain,
  InitiatorFrame,
  RawInitiator,
  Relationship,
  RelationshipKind,
} from "./relationships.js";

export { dependenciesFor, extractIdentifiers, valuesIn } from "./flow.js";
export type { FlowSource, FlowedValue } from "./flow.js";

export { buildSequences, meaningfulSequences } from "./sequence.js";
export type {
  ApiSequence,
  BuildSequencesOptions,
  SequenceModel,
  SequencePosition,
} from "./sequence.js";

export { buildApiModel } from "./model.js";
export type { ApiModel, ApiObject, ApiObservation, BuildApiModelOptions } from "./model.js";
