/** Evidence clock abstraction. Every privileged operation reads time through a Clock. */
export interface Clock {
  now(): Date;
  /** Human-readable source label persisted with the desk. */
  source(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  source(): string {
    return "system";
  }
}

/** Deterministic clock for tests, replay and frozen-cutoff checks. */
export class FrozenClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return new Date(this.at.getTime());
  }
  set(at: Date): void {
    this.at = at;
  }
  source(): string {
    return `frozen:${this.at.toISOString()}`;
  }
}

/** Offset clock for clock-skew drills. */
export class OffsetClock implements Clock {
  constructor(
    private base: Clock,
    private offsetMs: number,
  ) {}
  now(): Date {
    return new Date(this.base.now().getTime() + this.offsetMs);
  }
  source(): string {
    return `${this.base.source()}+${this.offsetMs}ms`;
  }
}

export function clockFromEnv(env = process.env): Clock {
  if (env.SW_CLOCK_FROZEN_AT) return new FrozenClock(new Date(env.SW_CLOCK_FROZEN_AT));
  return new SystemClock();
}
