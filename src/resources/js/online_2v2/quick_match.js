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
    this.advertised = null;
    this.publishTail = Promise.resolve();
  }
  async start({ name, layout, settings }) {
    if (!this.room.closed || this.active)
      throw new Error('Leave the current room or search first.');
    const generation = ++this.generation;
    this.active = true;
    this.changed();
    this.options = { layout };
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
            await this.room.create(name, layout, slots, settings, 'public');
          else
            await this.room.join(
              result.roomId,
              name,
              slots,
              result.hostId,
              true
            );
        } catch (error) {
          if (
            result.action === 'create' ||
            !/started|closed|occupied|not found|full|private|advertised host/i.test(
              error.message
            )
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
          await this.sync();
          this.notify('hosting');
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
  // Advertising follows the room, independently of how it was created.
  // Serialize publish/cancel so a late request cannot reopen a private room.
  sync(force = false) {
    const task = this.publishTail.then(async () => {
      clearTimeout(this.timer);
      const room = this.room;
      const open =
        !room.closed &&
        room.isHost &&
        room.data?.visibility === 'public' &&
        room.data.status === 'lobby';
      try {
        if (open) {
          const packet = {
            action: 'publish',
            roomId: room.id,
            layout: room.data.layout,
            visibility: 'public',
            status: 'lobby',
            members: Object.keys(room.data.members),
          };
          const signature = JSON.stringify(packet);
          if (force || signature !== this.advertised) {
            // Retain the marker on failure: retrying privacy/leave must cancel
            // an advertisement that the server may have received already.
            this.advertised = signature;
            const result = await this.request(packet);
            if (result.action === 'closed') this.advertised = null;
          }
        } else if (this.advertised) {
          await this.request({ action: 'cancel' });
          this.advertised = null;
        }
      } finally {
        if (open || this.advertised) {
          this.timer = setTimeout(() => {
            this.sync(true).catch((error) => this.notify('error', error));
          }, 2000);
          this.timer.unref?.();
        }
      }
    });
    this.publishTail = task.catch(() => {});
    return task;
  }
  async stop() {
    this.generation++;
    this.active = false;
    clearTimeout(this.timer);
    this.changed();
    const cancel = this.publishTail.then(async () => {
      clearTimeout(this.timer);
      await this.request({ action: 'cancel' });
      this.advertised = null;
    });
    this.publishTail = cancel.catch(() => {});
    await cancel.catch(() => {});
  }
}
