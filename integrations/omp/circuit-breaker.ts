export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
	threshold: number;
	cooldownMs: number;
}

export class CircuitBreaker {
	private state: CircuitState = "CLOSED";
	private consecutiveFailures = 0;
	private lastFailureTime = 0;

	constructor(private readonly opts: CircuitBreakerOptions) {}

	getState(): CircuitState {
		if (
			this.state === "OPEN" &&
			Date.now() - this.lastFailureTime > this.opts.cooldownMs
		) {
			this.state = "HALF_OPEN";
		}
		return this.state;
	}

	canRequest(): boolean {
		return this.getState() === "CLOSED" || this.getState() === "HALF_OPEN";
	}

	recordSuccess(): void {
		this.consecutiveFailures = 0;
		this.state = "CLOSED";
	}

	recordFailure(): void {
		this.consecutiveFailures++;
		this.lastFailureTime = Date.now();
		if (this.consecutiveFailures >= this.opts.threshold) {
			if (this.state !== "OPEN") {
				console.warn(
					`[agentmemory] circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures; cooldown ${this.opts.cooldownMs}ms`,
				);
			}
			this.state = "OPEN";
		}
	}
}