import { DurableObject } from 'cloudflare:workers';

const SIZE = 10;

const initialBoard = () =>
  Array.from({ length: SIZE }, (_, r) =>
    Array.from({ length: SIZE }, (_, c) =>
      (r + c) % 2 !== 1
        ? null
        : r < 4
          ? 'black'
          : r > 5
            ? 'red'
            : null
    )
  );

const owner = piece =>
  piece?.startsWith('red')
    ? 'red'
    : piece?.startsWith('black')
      ? 'black'
      : null;

const isKing = piece => piece?.endsWith('-king');

const inside = (r, c) =>
  Number.isInteger(r) &&
  Number.isInteger(c) &&
  r >= 0 &&
  r < SIZE &&
  c >= 0 &&
  c < SIZE;

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store'
    }
  });

export class GameRoom extends DurableObject {

  async load() {
    if (this.ready) return;

    this.board =
      await this.ctx.storage.get('board') ??
      initialBoard();

    this.turn =
      await this.ctx.storage.get('turn') ??
      'red';

    this.players =
      await this.ctx.storage.get('players') ??
      {};

    this.winner =
      await this.ctx.storage.get('winner') ??
      null;

    this.ready = true;
  }

  async save() {
    await this.ctx.storage.put({
      board: this.board,
      turn: this.turn,
      players: this.players,
      winner: this.winner
    });
  }

  hasLegalMove(color) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {

        if (owner(this.board[r][c]) !== color) {
          continue;
        }

        for (let rr = 0; rr < SIZE; rr++) {
          for (let cc = 0; cc < SIZE; cc++) {

            if (
              this.validate(
                [r, c],
                [rr, cc],
                color
              ).ok
            ) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  validate(from, to, color) {

    if (
      !Array.isArray(from) ||
      !Array.isArray(to) ||
      from.length !== 2 ||
      to.length !== 2
    ) {
      return {
        error: 'Koordinat tidak sah'
      };
    }

    const [r1, c1] = from;
    const [r2, c2] = to;

    if (
      !inside(r1, c1) ||
      !inside(r2, c2) ||
      (r1 === r2 && c1 === c2)
    ) {
      return {
        error: 'Petak tidak sah'
      };
    }

    const piece = this.board[r1][c1];

    if (
      owner(piece) !== color ||
      this.board[r2][c2] !== null
    ) {
      return {
        error: 'Buah atau petak sasaran tidak sah'
      };
    }

    const dr = r2 - r1;
    const dc = c2 - c1;

    const ar = Math.abs(dr);
    const ac = Math.abs(dc);

    // PERATURAN BUAH DAM BIASA

    if (!isKing(piece)) {

      const direction =
        color === 'red' ? -1 : 1;

      // Gerak biasa menyerong ke hadapan

      if (
        dr === direction &&
        ac === 1
      ) {
        return {
          ok: true,
          captures: []
        };
      }

      // Makan menyerong ke hadapan sahaja

      if (
        dr === 2 * direction &&
        ac === 2
      ) {

        const mr = r1 + direction;
        const mc = c1 + Math.sign(dc);

        const opponent =
          color === 'red'
            ? 'black'
            : 'red';

        if (
          owner(this.board[mr][mc]) ===
          opponent
        ) {
          return {
            ok: true,
            captures: [[mr, mc]]
          };
        }
      }

      return {
        error:
          'Dam biasa hanya boleh bergerak atau makan menyerong ke hadapan'
      };
    }

    // PERATURAN BUAH HAJI
    // Menyerong atau menegak
    // Boleh bergerak jauh

    if (
      !(
        ar === ac ||
        (dc === 0 && ar > 0)
      )
    ) {
      return {
        error:
          'Buah Haji hanya boleh bergerak menyerong atau menegak'
      };
    }

    const sr = Math.sign(dr);
    const sc = Math.sign(dc);

    const distance = Math.max(ar, ac);

    const captures = [];

    for (let i = 1; i < distance; i++) {

      const p =
        this.board[
          r1 + i * sr
        ][
          c1 + i * sc
        ];

      if (!p) continue;

      // Tidak boleh melangkaui buah sendiri

      if (owner(p) === color) {
        return {
          error:
            'Tidak boleh melangkaui buah sendiri'
        };
      }

      captures.push([
        r1 + i * sr,
        c1 + i * sc
      ]);

      if (captures.length > 1) {
        return {
          error:
            'Hanya satu buah lawan boleh dimakan setiap langkah'
        };
      }
    }

    return {
      ok: true,
      captures
    };
  }

  async fetch(request) {

    await this.load();

    const url = new URL(request.url);

    const action =
      url.pathname.split('/').at(-1);

    // STATUS PERMAINAN

    if (
      action === 'state' &&
      request.method === 'GET'
    ) {
      return json({
        board: this.board,
        turn: this.turn,
        players: Object.keys(
          this.players
        ).length,
        winner: this.winner
      });
    }

    // PEMAIN MASUK BILIK

    if (
      action === 'join' &&
      request.method === 'POST'
    ) {

      if (
        Object.keys(this.players).length >= 2
      ) {
        return json({
          error: 'Bilik penuh'
        }, 403);
      }

      const playerId =
        crypto.randomUUID();

      const color =
        Object.keys(this.players).length === 0
          ? 'red'
          : 'black';

      this.players[playerId] = color;

      await this.save();

      return json({
        playerId,
        color,
        board: this.board,
        turn: this.turn,
        winner: this.winner
      });
    }

    // PERGERAKAN BUAH

    if (
      action === 'move' &&
      request.method === 'POST'
    ) {

      let data;

      try {
        data = await request.json();
      } catch {
        return json({
          error: 'JSON tidak sah'
        }, 400);
      }

      const color =
        this.players[data?.playerId];

      if (!color) {
        return json({
          error: 'Pemain tidak dikenali'
        }, 403);
      }

      if (this.winner) {
        return json({
          error: 'Permainan sudah tamat',
          winner: this.winner
        }, 409);
      }

      if (color !== this.turn) {
        return json({
          error: 'Bukan giliran anda'
        }, 403);
      }

      if (
        Object.keys(this.players).length < 2
      ) {
        return json({
          error: 'Menunggu pemain kedua'
        }, 409);
      }

      const result = this.validate(
        data.from,
        data.to,
        color
      );

      if (!result.ok) {
        return json({
          error: result.error
        }, 400);
      }

      const [r1, c1] = data.from;
      const [r2, c2] = data.to;

      let piece = this.board[r1][c1];

      // Kosongkan petak asal

      this.board[r1][c1] = null;

      // Buang buah lawan yang dimakan

      for (
        const [r, c] of result.captures
      ) {
        this.board[r][c] = null;
      }

      // NAIK HAJI

      if (
        !isKing(piece) &&
        (r2 === 0 || r2 === SIZE - 1)
      ) {
        piece = color + '-king';
      }

      // Letakkan buah pada petak baharu

      this.board[r2][c2] = piece;

      const next =
        color === 'red'
          ? 'black'
          : 'red';

      this.turn = next;

      // SEMAK PEMENANG

      if (!this.hasLegalMove(next)) {
        this.winner = color;
      }

      await this.save();

      return json({
        success: true,
        board: this.board,
        turn: this.turn,
        winner: this.winner,
        captures: result.captures
      });
    }

    // PERMAINAN BAHARU

    if (
      action === 'reset' &&
      request.method === 'POST'
    ) {

      let data;

      try {
        data = await request.json();
      } catch {
        return json({
          error: 'JSON tidak sah'
        }, 400);
      }

      if (!this.players[data?.playerId]) {
        return json({
          error: 'Pemain tidak dikenali'
        }, 403);
      }

      this.board = initialBoard();
      this.turn = 'red';
      this.winner = null;

      await this.save();

      return json({
        success: true,
        board: this.board,
        turn: this.turn
      });
    }

    return json({
      error: 'Laluan atau kaedah tidak sah'
    }, 404);
  }
}

// CLOUDFLARE WORKER UTAMA

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    const match = url.pathname.match(
      /^\/room\/([a-zA-Z0-9-]{1,40})\/(join|move|state|reset)$/
    );

    if (!match) {
      return json({
        app: 'Dam Haji Online 10x10',
        status: 'Pelayan aktif',
        endpoints: [
          '/room/KOD/join',
          '/room/KOD/state',
          '/room/KOD/move',
          '/room/KOD/reset'
        ]
      });
    }

    if (!env.GAME_ROOMS) {
      return json({
        error:
          'Binding GAME_ROOMS belum dikonfigurasi'
      }, 503);
    }

    const id =
      env
