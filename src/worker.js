import { DurableObject } from 'cloudflare:workers';

// International draughts 10x10
const N = 10;
const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
const inB = (r,c) => r>=0 && r<N && c>=0 && c<N;
const who = p => p ? p.split('-')[0] : null;
const king = p => !!p && p.endsWith('-king');
const other = p => p==='red' ? 'black' : 'red';

function initialBoard() {
  return Array.from({length:N},(_,r)=>
    Array.from({length:N},(_,c)=>
      (r+c)%2===1 ? (r<4?'black':r>5?'red':null) : null
    )
  );
}

const clone = b => b.map(row=>row.slice());

function capturesFrom(b,r,c) {
  const piece=b[r][c], side=who(piece), found=[];

  for(const [dr,dc] of DIAG) 
  {   
    if(!king(piece) && dr !==
      (side==='red' ? -1 : 1 ))
    continue;
     if (king(piece))  {
      let x=r+dr,y=c+dc,enemy=null;

      while(inB(x,y)) {
        const p=b[x][y];

        if(p) {
          if(who(p)===side || enemy) break;
          enemy=[x,y];
        } else if(enemy) {
          const nb=clone(b);
          nb[r][c]=null;
          nb[enemy[0]][enemy[1]]=null;
          nb[x][y]=piece;

          const tails=capturesFrom(nb,x,y);

          if(tails.length) {
            for(const t of tails)
              found.push({
                path:[[x,y],...t.path],
                taken:[enemy,...t.taken]
              });
          } else {
            found.push({
              path:[[x,y]],
              taken:[enemy]
            });
          }
        }
        x+=dr;
        y+=dc;
      }
    } else {
      const x=r+dr,y=c+dc;
      const z=x+dr,w=y+dc;

      if(inB(z,w) &&
         who(b[x][y])===other(side) &&
         !b[z][w]) {

        const nb=clone(b);
        nb[r][c]=null;
        nb[x][y]=null;
        nb[z][w]=piece;

        const tails=capturesFrom(nb,z,w);

        if(tails.length) {
          for(const t of tails)
            found.push({
              path:[[z,w],...t.path],
              taken:[[x,y],...t.taken]
            });
        } else {
          found.push({
            path:[[z,w]],
            taken:[[x,y]]
          });
        }
      }
    }
  }
  return found;
}

function legalMoves(b,color) {
  let all=[],cap=[];

  for(let r=0;r<N;r++) {
    for(let c=0;c<N;c++) {
      const piece=b[r][c];
      if(who(piece)!==color) continue;

      for(const m of capturesFrom(b,r,c))
        cap.push({from:[r,c],...m});

      if(king(piece)) {
        for(const [dr,dc] of DIAG) {
          let x=r+dr,y=c+dc;

          while(inB(x,y) && !b[x][y]) {
            all.push({
              from:[r,c],
              path:[[x,y]],
              taken:[]
            });
            x+=dr;
            y+=dc;
          }
        }
      } else {
        const dr=color==='red'?-1:1;

        for(const dc of [-1,1]) {
          const x=r+dr,y=c+dc;

          if(inB(x,y) && !b[x][y])
            all.push({
              from:[r,c],
              path:[[x,y]],
              taken:[]
            });
        }
      }
    } 
  } 
  return [...cap, ...all];

  
  }




function playMove(b,m) {
  const nb=clone(b);
  const [r,c]=m.from;
  const [endR,endC]=m.path.at(-1);

  let piece=nb[r][c];
  nb[r][c]=null;

  for(const [x,y] of m.taken)
    nb[x][y]=null;

  if(!king(piece) &&
     endR===(who(piece)==='red'?0:9))
    piece=who(piece)+'-king';

  nb[endR][endC]=piece;
  return nb;
}

function matchMove(m,from,path) {
  return JSON.stringify(m.from)===JSON.stringify(from) &&
         JSON.stringify(m.path)===JSON.stringify(path);
}

function outcome(b,turn) {
  const count={red:0,black:0};

  for(const row of b)
    for(const p of row)
      if(p) count[who(p)]++;

  if(!count.red) return 'black';
  if(!count.black) return 'red';

  return legalMoves(b,turn).length ? null : other(turn);
}

const json=(data,status=200)=>
  Response.json(data,{
    status,
    headers:{'Cache-Control':'no-store'}
  });

export class GameRoom extends DurableObject {
  async load() {
    if(this.ready) return;

    this.board=await this.ctx.storage.get('board')??initialBoard();
    this.turn=await this.ctx.storage.get('turn')??'red';
    this.players=await this.ctx.storage.get('players')??{};
    this.winner=await this.ctx.storage.get('winner')??null;
    this.ready=true;
  }

  async save() {
    await this.ctx.storage.put({
      board:this.board,
      turn:this.turn,
      players:this.players,
      winner:this.winner
    });
  }

  async fetch(req) {
    await this.load();

    const action=new URL(req.url).pathname.split('/').at(-1);

    if(action==='state' && req.method==='GET')
      return json({
        board:this.board,
        turn:this.turn,
        players:Object.keys(this.players).length,
        winner:this.winner
      });

    if(action==='join' && req.method==='POST') {
      if(Object.keys(this.players).length>=2)
        return json({error:'Bilik penuh'},403);

      const playerId=crypto.randomUUID();
      const color=Object.keys(this.players).length===0
        ? 'red' : 'black';

      this.players[playerId]=color;
      await this.save();

      return json({
        playerId,
        color,
        board:this.board,
        turn:this.turn,
        winner:this.winner
      });
    }

    if(['move','reset'].includes(action) &&
       req.method==='POST') {

      let data;
      try {
        data=await req.json();
      } catch {
        return json({error:'Data JSON tidak sah'},400);
      }

      const color=this.players[data?.playerId];

      if(!color)
        return json({error:'Pemain tidak dikenali'},403);

      if(action==='reset') {
        this.board=initialBoard();
        this.turn='red';
        this.winner=null;
        await this.save();

        return json({
          success:true,
          board:this.board,
          turn:this.turn,
          winner:null
        });
      }

      if(this.winner)
        return json({error:'Permainan telah tamat'},409);

      if(Object.keys(this.players).length<2)
        return json({error:'Menunggu pemain kedua'},409);

      if(color!==this.turn)
        return json({error:'Bukan giliran anda'},403);

      const legal=legalMoves(this.board,color);

      const m=legal.find(m=>
        matchMove(m,data.from,data.path)
      );

      if(!m)
        return json({
          error:'Langkah tidak sah mengikut peraturan permainan.'
        },400);

      this.board=playMove(this.board,m);
      this.turn=other(color);
      this.winner=outcome(this.board,this.turn);

      await this.save();

      return json({
        success:true,
        board:this.board,
        turn:this.turn,
        winner:this.winner,
        captures:m.taken
      });
    }

    return json({error:'Laluan tidak sah'},404);
  }
}

export default {
  async fetch(req,env) {
    const url=new URL(req.url);

    const match=url.pathname.match(
      /^\/room\/([a-zA-Z0-9-]{1,40})\/(join|move|state|reset)$/
    );

    if(!match)
      return env.ASSETS.fetch(req);

    if(!env.GAME_ROOMS)
      return json({error:'GAME_ROOMS belum tersedia'},503);

    const id=env.GAME_ROOMS.idFromName(match[1]);
    return env.GAME_ROOMS.get(id).fetch(req);
  }
};
