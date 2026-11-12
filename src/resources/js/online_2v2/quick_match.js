export class QuickMatch {
  constructor({
    room,
    request,
    notify = () => {},
    changed = () => {},
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.room = room;
    this.request = request;
    this.notify = notify;
    this.changed = changed;
    this.wait = wait;
    this.generation = 0;
    this.active = false;
    this.timer = null;
  }
  async start({ name, layout, region = 'GLOBAL', settings }) {
    if (!this.room.closed || this.active)
      throw new Error('Leave the current room or search first.');
    const generation = ++this.generation;
    this.active = true;
    this.changed();
    this.options = { layout, region };
    try {
      while (this.active && generation === this.generation) {
        const result = await this.request({ action: 'find', ...this.options });
        if (generation !== this.generation) return;
        if (result.action === 'wait') {
          this.notify('waiting');
          await this.wait(1000);
          continue;
        }
        if (!['create', 'join'].includes(result.action))
          throw new Error('Unexpected matchmaking response.');
        const slots = [];
        try {
          if (result.action === 'create')
            await this.room.create(name, layout, slots, settings);
          else await this.room.join(result.roomId, name, slots, result.hostId);
        } catch (error) {
          if (
            result.action === 'create' ||
            !/started|closed|occupied|not found|full/i.test(error.message)
          )
            throw error;
          // A host may start early, or an invited player may claim this advisory reservation.
          await this.request({ action: 'cancel' });
          await this.wait(1000);
          continue;
        }
        if (generation !== this.generation) {
          await this.room.leave();
          return;
        }
        if (this.room.isHost) {
          await this.request({
            action: 'publish',
            roomId: this.room.id,
            ...this.options,
            ...this.advertisement(),
          });
          this.notify('hosting');
          this.heartbeat(generation);
        } else {
          this.active = false;
          // The host admitted this browser over WebRTC before acknowledging.
          await this.request({ action: 'joined' }).catch(() => {});
          this.notify('joined');
        }
        this.changed();
        return;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.active = false;
        await this.request({ action: 'cancel' }).catch(() => {});
        this.changed();
        throw error;
      }
    }
  }
  advertisement() {
    return {
      status: this.room.data.status,
      members: Object.keys(this.room.data.members),
    };
  }
  heartbeat(generation) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (!this.active || generation !== this.generation) return;
      if (this.room.closed || this.room.data.status !== 'lobby') {
        await this.stop();
        return;
      }
      try {
        const result = await this.request({
          action: 'publish',
          roomId: this.room.id,
          ...this.options,
          ...this.advertisement(),
        });
        if (result.action === 'closed') {
          await this.stop();
          return;
        }
      } catch (error) {
        this.notify('error', error);
      }
      if (this.active && generation === this.generation)
        this.heartbeat(generation);
    }, 2000);
  }
  async stop() {
    this.generation++;
    this.active = false;
    clearTimeout(this.timer);
    this.changed();
    await this.request({ action: 'cancel' }).catch(() => {});
  }
}
