/**
 * tinyquest — a tiny, content-creator-friendly game engine.
 *
 * Everything you need to write game content:
 *
 * ```ts
 * import { Character, Engine, buff, cast, skill } from 'tinyquest';
 * ```
 */
export {
  Gauge,
  gaugeFrom,
  isGaugeInstance,
  type GaugeOptions,
  type GaugeDef,
  type GaugeSba,
  type GaugeBuffGate,
} from './gauge.js';

export {
  type Action,
  type Actions,
  /**
   * The open action map (declared in `contracts.ts`). Games declare their own
   * actions by augmenting it, then register a handler with
   * `engine.actions.register(...)`.
   */
  type ActionMap,
  /** The pipeline fields every action must carry — extend this on a custom action. */
  type ActionBase,
  type ActionContext,
  type ActionDirection,
  type ActionTransformer,
  type MoveAction,
  type GaugeUpdate,
  type GaugeIntent,
  type TransformForm,
  gaugeTransform,
  gaugeTransformCtx,
  gaugeDelta,
  replaceAction,
  redirectGauge,
  setGauge,
  changeGaugeBy,
  damage,
  heal,
  addBuff,
  removeBuff,
  destroy,
  move,
  transform,
  popTransform,
} from './actions.js';

export {
  type GameEvent,
  /**
   * The open event map (declared in `contracts.ts`). Games declare their own
   * events by augmenting it; triggered abilities can then subscribe to them
   * and `ctx.event` narrows on them like any built-in.
   */
  type GameEventMap,
  type EventSource,
  type GaugeChangedEvent,
  type GaugeMaxChangedEvent,
  type StatChangedEvent,
  type GaugeWrite,
  type GaugeMaxChange,
  type CharacterTransformedEvent,
  type TransformReason,
  type DestroyReason,
  type BuffDestroyReason,
  type CharacterDestroyedEvent,
  type CharacterSurvivedEvent,
  type ZoneChangedEvent,
  type ZoneChangedBatchEvent,
  type ZoneRef,
  type EventHandler,
  EventBus,
  isGaugeChange,
  isZoneChange,
  isDeath,
  leftPlay,
  amountOf,
} from './events.js';

export {
  type Status,
  type Statuses,
  type StatusDef,
  type StatusDirection,
  type BuffDef,
  Buff,
  buff,
  type SkillDef,
  Skill,
  skill,
  StatusManager,
} from './status/index.js';

export {
  type RestrictionInstance,
  type BlockedAttempt,
} from './restrictions.js';

export {
  type Ability,
  type ManualAbility,
  type TriggeredAbility,
  type AnyTriggeredAbility,
  type PassiveActionModifier,
  type PassiveActionModifierDef,
  type MaxModifierAbility,
  type MaxModifierDef,
  type TransformModifierAbility,
  type TransformModifierDef,
  type RestrictionAbility,
  type RestrictionDef,
  /**
   * The open restriction-kind map (declared in `contracts.ts`). Games declare
   * their own attempt kinds by augmenting it — see
   * `src/games/round-based/win-lose.ts` for `win`/`lose`.
   */
  type RestrictionKindMap,
  type RestrictionKind,
  type AttemptContext,
  type AbilityContext,
  type TriggerContext,
  type TargetWho,
  type TargetPattern,
  type TargetingContext,
  type TargetCondition,
  type Targeting,
  type CastResult,
  cast,
  auto,
  prompt,
  maxModifier,
  stat,
  type StatAbility,
  type StatContext,
  type StatDef,
  transformModifier,
  passiveActionModifier,
  restriction,
} from './ability/index.js';

export {
  type CharacterDef,
  type TransformEntry,
  type SkillSwap,
  type FormChange,
  type TransformPop,
  type GaugeLanding,
  type GaugeLandingWrite,
  Character,
} from './character.js';

export {
  Player,
} from './player.js';

export {
  autoChoose,
  countRange,
  validateAnswer,
  AutoChooser,
  ScriptedChooser,
  type Chooser,
  type ChoiceRequest,
  type ChoiceAnswer,
  type SelectRequest,
  type SelectAnswer,
  type ConfirmRequest,
  type ConfirmAnswer,
} from './choice.js';

export {
  Zone,
  ZoneRegistry,
  PLAY,
  GRAVEYARD,
  IN_PLAY,
  REMOVED,
  type Entity,
  type ZoneDef,
  type ZonePosition,
  type ZoneScope,
  type ZoneTransition,
  type ZoneVisibility,
} from './zone.js';

/**
 * The action registry (action-registry.ts) — the runtime half of the open
 * `ActionMap`. Reach it as `engine.actions`.
 */
export {
  ActionRegistry,
  type ActionHandler,
  type ActionExecutionContext,
} from './action-registry.js';

export {
  type DeferredTrigger,
  ImmediateScheduler,
  type ReadyTrigger,
  type TriggerScheduler,
  type AbilityAvailability,
  type EngineOptions,
  type StateBasedRule,
  GameEngine,
} from './engine.js';

export {
  type Decision,
  GameEndInterrupt,
  Game,
} from './game.js';

export {
  hashString,
  commitSecret,
  verifyCommit,
  buildSeed,
  createPrng,
  shuffle,
  createRandomSeed,
  type SeedContribution,
} from './seed.js';
