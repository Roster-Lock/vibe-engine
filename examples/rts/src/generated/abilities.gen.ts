/*
 * Generated from src/content/abilities.rts — do not edit.
 *
 * Run `npm run rts:codegen` to regenerate. Every function below was
 * written as an English sentence; this is what the compiler turned it
 * into. It is ordinary TypeScript: the project typechecks it, and the
 * battle in `npm run rts:demo -- --compiled` runs it.
 */
import type { BuffProgram } from '../ir.js';
import type { CastApi, CompiledAbility } from '../english/runtime.js';
import type { Unit } from '../sim/unit.js';

/** The living members of a selection that may contain absent nouns. */
function living(...units: readonly (Unit | undefined)[]): Unit[] {
  return units.filter((unit): unit is Unit => unit !== undefined && unit.alive);
}

/** `Storm Bolt` — enemy unit, 75 mana, 7s cooldown, 600 range */
export const stormBolt: CompiledAbility = {
  id: 'storm-bolt',
  name: 'Storm Bolt',
  targeting: 'enemyUnit',
  cooldown: 7,
  manaCost: 75,
  castRange: 600,
  cast(ctx: CastApi): void {
    for (const unit1 of living(ctx.target)) {
      ctx.damage(unit1, 180);
    }
    for (const unit2 of living(ctx.target)) {
      ctx.addBuff(unit2, 'stunned');
    }
  },
};

/** `Thunder Clap` — no target, 75 mana, 9s cooldown */
export const thunderClap: CompiledAbility = {
  id: 'thunder-clap',
  name: 'Thunder Clap',
  targeting: 'none',
  cooldown: 9,
  manaCost: 75,
  castRange: 0,
  cast(ctx: CastApi): void {
    for (const unit1 of ctx.area({ who: 'enemy', radius: 300, from: ctx.self.pos })) {
      ctx.damage(unit1, 100);
    }
    for (const unit2 of ctx.area({ who: 'enemy', radius: 300, from: ctx.self.pos })) {
      ctx.addBuff(unit2, 'slowed');
    }
  },
};

/** `Avatar` — no target, 125 mana, 30s cooldown */
export const avatar: CompiledAbility = {
  id: 'avatar',
  name: 'Avatar',
  targeting: 'none',
  cooldown: 30,
  manaCost: 125,
  castRange: 0,
  cast(ctx: CastApi): void {
    if (ctx.self.alive) {
      ctx.addBuff(ctx.self, 'avatar-form');
    }
  },
};

/** `Healing Wave` — ally unit, 65 mana, 6s cooldown, 700 range */
export const healingWave: CompiledAbility = {
  id: 'healing-wave',
  name: 'Healing Wave',
  targeting: 'allyUnit',
  cooldown: 6,
  manaCost: 65,
  castRange: 700,
  cast(ctx: CastApi): void {
    for (const unit1 of living(ctx.target)) {
      ctx.heal(unit1, 215);
    }
  },
};

/** `Rejuvenation` — ally unit, 65 mana, 8s cooldown, 700 range */
export const rejuvenation: CompiledAbility = {
  id: 'rejuvenation',
  name: 'Rejuvenation',
  targeting: 'allyUnit',
  cooldown: 8,
  manaCost: 65,
  castRange: 700,
  cast(ctx: CastApi): void {
    for (const unit1 of living(ctx.target)) {
      ctx.addBuff(unit1, 'rejuvenating');
    }
  },
};

/** `Carrion Swarm` — point, 110 mana, 9s cooldown, 700 range */
export const carrionSwarm: CompiledAbility = {
  id: 'carrion-swarm',
  name: 'Carrion Swarm',
  targeting: 'point',
  cooldown: 9,
  manaCost: 110,
  castRange: 700,
  cast(ctx: CastApi): void {
    for (const unit1 of ctx.area({ who: 'enemy', radius: 220, from: ctx.point })) {
      ctx.damage(unit1, 90);
    }
  },
};

/** `Raise Dead` — no target, 95 mana, 22s cooldown */
export const raiseDead: CompiledAbility = {
  id: 'raise-dead',
  name: 'Raise Dead',
  targeting: 'none',
  cooldown: 22,
  manaCost: 95,
  castRange: 0,
  cast(ctx: CastApi): void {
    ctx.summon('skeleton-warrior', 2, ctx.self.pos);
  },
};

/** `Cleave` — no target */
export const cleave: CompiledAbility = {
  id: 'cleave',
  name: 'Cleave',
  targeting: 'none',
  cooldown: 0,
  manaCost: 0,
  castRange: 0,
  // A passive: nothing happens on cast.
  cast(): void {},
  triggers: {
    attacks(ctx: CastApi): void {
      for (const unit1 of ctx.area({ who: 'enemy', radius: 150, from: ctx.role('victim')?.pos })) {
        ctx.damage(unit1, ctx.self.stat('attackDamage') * 0.3);
      }
    },
  },
};

/** `Thorns Aura` — no target */
export const thornsAura: CompiledAbility = {
  id: 'thorns-aura',
  name: 'Thorns Aura',
  targeting: 'none',
  cooldown: 0,
  manaCost: 0,
  castRange: 0,
  // A passive: nothing happens on cast.
  cast(): void {},
  triggers: {
    damaged(ctx: CastApi): void {
      for (const unit1 of living(ctx.role('attacker'))) {
        ctx.damage(unit1, 25);
      }
    },
  },
};

/** `Envenomed Spears` — no target */
export const envenomedSpears: CompiledAbility = {
  id: 'envenomed-spears',
  name: 'Envenomed Spears',
  targeting: 'none',
  cooldown: 0,
  manaCost: 0,
  castRange: 0,
  // A passive: nothing happens on cast.
  cast(): void {},
  triggers: {
    attacks(ctx: CastApi): void {
      for (const unit1 of living(ctx.role('victim'))) {
        ctx.addBuff(unit1, 'poisoned');
      }
    },
  },
};

/** `Feast` — no target */
export const feast: CompiledAbility = {
  id: 'feast',
  name: 'Feast',
  targeting: 'none',
  cooldown: 0,
  manaCost: 0,
  castRange: 0,
  // A passive: nothing happens on cast.
  cast(): void {},
  triggers: {
    kills(ctx: CastApi): void {
      for (const unit1 of ctx.area({ who: 'ally', radius: 400, from: ctx.self.pos }).filter((unit) => unit.stat('hp') < unit.stat('maxHp') * 0.6)) {
        ctx.heal(unit1, 60);
      }
    },
  },
};

/** `Blink` — point, 40 mana, 10s cooldown, 700 range */
export const blink: CompiledAbility = {
  id: 'blink',
  name: 'Blink',
  targeting: 'point',
  cooldown: 10,
  manaCost: 40,
  castRange: 700,
  cast(ctx: CastApi): void {
    const at1 = ctx.point;
    if (at1) {
      if (ctx.self.alive) {
        ctx.teleport(ctx.self, at1);
      }
    }
  },
};

/** `War Stomp` — no target, 90 mana, 12s cooldown */
export const warStomp: CompiledAbility = {
  id: 'war-stomp',
  name: 'War Stomp',
  targeting: 'none',
  cooldown: 12,
  manaCost: 90,
  castRange: 0,
  cast(ctx: CastApi): void {
    for (const unit1 of ctx.area({ who: 'enemy', radius: 250, from: ctx.self.pos })) {
      ctx.push(unit1, ctx.self.pos, 130);
    }
    for (const unit2 of ctx.area({ who: 'enemy', radius: 250, from: ctx.self.pos })) {
      ctx.addBuff(unit2, 'stunned');
    }
  },
};

/** `Execute` — enemy unit, 50 mana, 15s cooldown, 500 range */
export const execute: CompiledAbility = {
  id: 'execute',
  name: 'Execute',
  targeting: 'enemyUnit',
  cooldown: 15,
  manaCost: 50,
  castRange: 500,
  cast(ctx: CastApi): void {
    for (const unit1 of living(ctx.target).filter((unit) => unit.stat('hp') < unit.stat('maxHp') * 0.15)) {
      ctx.kill(unit1);
    }
  },
};

/** `Delayed Blast` — point, 80 mana, 14s cooldown, 700 range */
export const delayedBlast: CompiledAbility = {
  id: 'delayed-blast',
  name: 'Delayed Blast',
  targeting: 'point',
  cooldown: 14,
  manaCost: 80,
  castRange: 700,
  cast(ctx: CastApi): void {
    ctx.after(2, () => {
      for (const unit1 of ctx.area({ who: 'enemy', radius: 180, from: ctx.point })) {
        ctx.damage(unit1, 260);
      }
    });
  },
};

/** Buff definitions stay data — the runtime interprets their ticks and triggers. */
export const COMPILED_BUFFS: readonly BuffProgram[] = [
  {
    "id": "stunned",
    "name": "Stunned",
    "duration": 3,
    "stacks": false,
    "modifiers": [],
    "restrictions": [
      "move",
      "attack",
      "cast"
    ],
    "triggers": [],
    "periodic": []
  },
  {
    "id": "slowed",
    "name": "Slowed",
    "duration": 6,
    "stacks": false,
    "modifiers": [
      {
        "stat": "moveSpeed",
        "mode": "percent",
        "amount": -50
      },
      {
        "stat": "attackSpeed",
        "mode": "percent",
        "amount": -25
      }
    ],
    "restrictions": [],
    "triggers": [],
    "periodic": []
  },
  {
    "id": "poisoned",
    "name": "Poisoned",
    "duration": 8,
    "stacks": true,
    "modifiers": [],
    "restrictions": [],
    "triggers": [],
    "periodic": [
      {
        "interval": 1,
        "effects": [
          {
            "kind": "damage",
            "amount": {
              "kind": "const",
              "value": 4
            },
            "units": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "rejuvenating",
    "name": "Rejuvenating",
    "duration": 12,
    "stacks": false,
    "modifiers": [],
    "restrictions": [],
    "triggers": [],
    "periodic": [
      {
        "interval": 1,
        "effects": [
          {
            "kind": "heal",
            "amount": {
              "kind": "const",
              "value": 22
            },
            "units": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "avatar-form",
    "name": "Avatar Form",
    "duration": 15,
    "stacks": false,
    "modifiers": [
      {
        "stat": "attackDamage",
        "mode": "flat",
        "amount": 20
      },
      {
        "stat": "armor",
        "mode": "flat",
        "amount": 5
      },
      {
        "stat": "moveSpeed",
        "mode": "percent",
        "amount": -15
      }
    ],
    "restrictions": [],
    "triggers": [],
    "periodic": []
  }
];

export const COMPILED_ABILITIES: readonly CompiledAbility[] = [stormBolt, thunderClap, avatar, healingWave, rejuvenation, carrionSwarm, raiseDead, cleave, thornsAura, envenomedSpears, feast, blink, warStomp, execute, delayedBlast];
