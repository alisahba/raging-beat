// Audio transport: decoded-buffer playback with sample-accurate timing,
// microphone input for live mode, and a stream tap for realtime recording.

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.offset = 0;        // track position while paused
    this.startedAt = 0;     // ctx time corresponding to track position 0
    this.loop = true;
    this.mode = 'track';    // 'track' | 'live'
    this.micStream = null;
    this.micNode = null;
    this._token = 0;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.tap = this.ctx.createGain();           // feeds recordings
      this.master.connect(this.tap);
    }
    return this.ctx;
  }

  async resume() {
    this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async decode(arrayBuffer) {
    this.ensureContext();
    return this.ctx.decodeAudioData(arrayBuffer);
  }

  setBuffer(buffer) {
    this.stopMic();
    this.pause();
    this.buffer = buffer;
    this.offset = 0;
    this.mode = 'track';
    this.dispatchEvent(new Event('change'));
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  // Track position in seconds (what is being heard, minus output latency)
  get time() {
    if (this.mode === 'live') return this.ctx ? this.ctx.currentTime : 0;
    if (!this.playing) return this.offset;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    let t = this.ctx.currentTime - this.startedAt - latency;
    if (this.loop && this.duration) t = ((t % this.duration) + this.duration) % this.duration;
    return Math.max(0, Math.min(t, this.duration));
  }

  async play() {
    if (this.mode !== 'track' || !this.buffer || this.playing) return;
    await this.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.connect(this.master);
    const token = ++this._token;
    src.onended = () => {
      if (token !== this._token) return;
      this.playing = false;
      this.offset = 0;
      this.source = null;
      this.dispatchEvent(new Event('ended'));
      this.dispatchEvent(new Event('change'));
    };
    const at = this.offset >= this.duration - 0.01 ? 0 : this.offset;
    src.start(0, at);
    this.startedAt = this.ctx.currentTime - at;
    this.source = src;
    this.playing = true;
    this.dispatchEvent(new Event('change'));
  }

  pause() {
    if (!this.playing) return;
    const t = this.time;
    this._token++;
    try { this.source.stop(); } catch {}
    this.source.disconnect();
    this.source = null;
    this.playing = false;
    this.offset = t;
    this.dispatchEvent(new Event('change'));
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(t) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = Math.max(0, Math.min(t, this.duration));
    if (was) this.play();
    else this.dispatchEvent(new Event('change'));
  }

  setLoop(on) {
    this.loop = on;
    if (this.source) this.source.loop = on;
  }

  setVolume(v) {
    this.ensureContext();
    this.master.gain.value = v;
  }

  async startMic() {
    await this.resume();
    this.pause();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.micStream = stream;
    this.micNode = this.ctx.createMediaStreamSource(stream);
    // Mic is analysed but not monitored (avoids feedback); recordings get it.
    this.micNode.connect(this.tap);
    this.mode = 'live';
    this.dispatchEvent(new Event('change'));
    return this.micNode;
  }

  stopMic() {
    if (!this.micStream) return;
    this.micStream.getTracks().forEach(t => t.stop());
    this.micNode.disconnect();
    this.micStream = null;
    this.micNode = null;
    this.mode = 'track';
    this.dispatchEvent(new Event('change'));
  }

  recordStream() {
    this.ensureContext();
    if (!this._recDest) {
      this._recDest = this.ctx.createMediaStreamDestination();
      this.tap.connect(this._recDest);
    }
    return this._recDest.stream;
  }
}
