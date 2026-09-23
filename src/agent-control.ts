/** Trusted, in-process intervention for one active Agent run at a time. */
export class AgentControl {
  private state: 'idle' | 'running' | 'paused' | 'ended' = 'idle';
  private pauseRequested = false;
  private pauseSettlers: Array<(paused: boolean) => void> = [];
  private resumeSettler?: () => void;
  private steering: string[] = [];
  private steeringBytes = 0;

  /** Resolve true when the run reaches a safe boundary; false if it ends first. */
  pause(): Promise<boolean> {
    if (this.state === 'paused') return Promise.resolve(true);
    if (this.state !== 'running') return Promise.resolve(false);
    this.pauseRequested = true;
    return new Promise(resolve => this.pauseSettlers.push(resolve));
  }

  /** Resume only after pause() reports true. The discarded plan is not replayed. */
  resume(): void {
    if (this.state !== 'paused') throw new Error('Agent is not paused. Await pause() before resuming.');
    this.pauseRequested = false;
    this.state = 'running';
    this.resumeSettler?.();
    this.resumeSettler = undefined;
  }

  /** Add a bounded trusted operator instruction for the next fresh plan. */
  steer(text: string): void {
    if (this.state !== 'running' && this.state !== 'paused') throw new Error('Agent is not running.');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 10_000 || this.steeringBytes + Buffer.byteLength(text) > 32_000) throw new Error('Steering text must be nonempty and fit the 10 KiB item / 32 KiB pending limits.');
    this.steering.push(text);
    this.steeringBytes += Buffer.byteLength(text);
  }

  /** @internal The runner owns lifecycle and safe-boundary calls. */
  begin(): void {
    if (this.state === 'running' || this.state === 'paused') throw new Error('AgentControl is already bound to an active run.');
    this.state = 'running';
    this.pauseRequested = false;
    this.pauseSettlers = [];
    this.resumeSettler = undefined;
    this.steering = [];
    this.steeringBytes = 0;
  }

  /** @internal Await at a point before another model decision or tool dispatch. */
  async boundary(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (!this.pauseRequested) return false;
    this.state = 'paused';
    for (const settle of this.pauseSettlers.splice(0)) settle(true);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      this.resumeSettler = () => { signal.removeEventListener('abort', abort); resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return true;
  }

  /** @internal Steering is appended only after complete assistant/tool groups. */
  get hasSteering(): boolean { return this.steering.length > 0; }
  /** @internal */
  takeSteering(): string[] {
    const queued = this.steering;
    this.steering = [];
    this.steeringBytes = 0;
    return queued;
  }

  /** @internal */
  end(): void {
    this.state = 'ended';
    this.pauseRequested = false;
    for (const settle of this.pauseSettlers.splice(0)) settle(false);
    this.resumeSettler = undefined;
    this.steering = [];
    this.steeringBytes = 0;
  }
}

export function createAgentControl(): AgentControl { return new AgentControl(); }
