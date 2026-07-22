import { PNG } from "pngjs";
import type { UserUsageData, ContextUsageBreakdownSnapshot } from "./usage-store.ts";

const FONT: Record<string, string[]> = {
  A:["01110","10001","10001","11111","10001","10001","10001"], B:["11110","10001","10001","11110","10001","10001","11110"],
  C:["01111","10000","10000","10000","10000","10000","01111"], D:["11110","10001","10001","10001","10001","10001","11110"],
  E:["11111","10000","10000","11110","10000","10000","11111"], F:["11111","10000","10000","11110","10000","10000","10000"],
  G:["01111","10000","10000","10111","10001","10001","01111"], H:["10001","10001","10001","11111","10001","10001","10001"],
  I:["11111","00100","00100","00100","00100","00100","11111"], J:["00111","00010","00010","00010","10010","10010","01100"],
  K:["10001","10010","10100","11000","10100","10010","10001"], L:["10000","10000","10000","10000","10000","10000","11111"],
  M:["10001","11011","10101","10101","10001","10001","10001"], N:["10001","11001","10101","10011","10001","10001","10001"],
  O:["01110","10001","10001","10001","10001","10001","01110"], P:["11110","10001","10001","11110","10000","10000","10000"],
  Q:["01110","10001","10001","10001","10101","10010","01101"], R:["11110","10001","10001","11110","10100","10010","10001"],
  S:["01111","10000","10000","01110","00001","00001","11110"], T:["11111","00100","00100","00100","00100","00100","00100"],
  U:["10001","10001","10001","10001","10001","10001","01110"], V:["10001","10001","10001","10001","10001","01010","00100"],
  W:["10001","10001","10001","10101","10101","11011","10001"], X:["10001","10001","01010","00100","01010","10001","10001"],
  Y:["10001","10001","01010","00100","00100","00100","00100"], Z:["11111","00001","00010","00100","01000","10000","11111"],
  "0":["01110","10001","10011","10101","11001","10001","01110"], "1":["00100","01100","00100","00100","00100","00100","01110"],
  "2":["01110","10001","00001","00010","00100","01000","11111"], "3":["11110","00001","00001","01110","00001","00001","11110"],
  "4":["00010","00110","01010","10010","11111","00010","00010"], "5":["11111","10000","10000","11110","00001","00001","11110"],
  "6":["01110","10000","10000","11110","10001","10001","01110"], "7":["11111","00001","00010","00100","01000","01000","01000"],
  "8":["01110","10001","10001","01110","10001","10001","01110"], "9":["01110","10001","10001","01111","00001","00001","01110"],
  " ":["00000","00000","00000","00000","00000","00000","00000"], ".":["00000","00000","00000","00000","00000","00110","00110"],
  ",":["00000","00000","00000","00000","00110","00110","00100"], ":":["00000","00110","00110","00000","00110","00110","00000"],
  "%":["11001","11010","00100","01000","10110","00110","00000"], "/":["00001","00010","00100","01000","10000","00000","00000"],
  "-":["00000","00000","00000","11111","00000","00000","00000"], "(":["00010","00100","01000","01000","01000","00100","00010"],
  ")":["01000","00100","00010","00010","00010","00100","01000"], "+":["00000","00100","00100","11111","00100","00100","00000"],
  "? ":["00000","00000","00000","00000","00000","00000","00000"], "?":["01110","10001","00001","00010","00100","00000","00100"],
};

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 .,:/%()\-+?]/g, "?");
}

function rgba(hex: string): [number, number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function setPixel(png: PNG, x: number, y: number, color: [number,number,number,number]): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0]; png.data[idx+1] = color[1]; png.data[idx+2] = color[2]; png.data[idx+3] = color[3];
}

function rect(png: PNG, x: number, y: number, w: number, h: number, color: [number,number,number,number]): void {
  for (let yy=y; yy<y+h; yy++) for (let xx=x; xx<x+w; xx++) setPixel(png,xx,yy,color);
}

function text(png: PNG, value: string, x: number, y: number, scale: number, color: [number,number,number,number]): void {
  let cursor=x;
  for (const ch of normalizeText(value)) {
    const glyph=FONT[ch] ?? FONT["?"]!;
    glyph.forEach((row,gy)=>{ for (let gx=0; gx<row.length; gx++) if (row[gx]==="1") rect(png,cursor+gx*scale,y+gy*scale,scale,scale,color); });
    cursor += 6*scale;
  }
}

function fmt(n: number): string { return Math.round(n).toLocaleString("en-US"); }
function pct(n: number): string { return `${Math.max(0,n).toFixed(1)}%`; }
function clamp(n:number,min:number,max:number){return Math.min(max,Math.max(min,n));}

function breakdownRows(ctx: ContextUsageBreakdownSnapshot): Array<[string,number]> {
  return [
    ["CONVERSACION", ctx.conversationTokens + ctx.currentMessageTokens],
    ["HERRAMIENTAS", ctx.toolTokens],
    ["SYSTEM PROMPT", ctx.systemTokens],
    ["MEMORIA PERFIL", ctx.profileMemoryTokens],
    ["BOVEDA", ctx.vaultMemoryTokens],
    ["RESUMEN COMPACTO", ctx.compactedSummaryTokens],
    ["SUPERVISOR", ctx.supervisorTokens],
    ["OTROS DINAMICOS", ctx.otherDynamicTokens],
  ];
}

export function renderUsageCard(data: UserUsageData, fallbackContext: ContextUsageBreakdownSnapshot): Buffer {
  const ctx=fallbackContext;
  const png=new PNG({width:1080,height:920});
  const bg=rgba("#0b1020"), panel=rgba("#151c31"), fg=rgba("#f5f7ff"), muted=rgba("#9da9c7"), accent=rgba("#7ea6ff"), barBg=rgba("#27314d"), green=rgba("#5bd39b"), amber=rgba("#f5bf63");
  rect(png,0,0,png.width,png.height,bg);
  text(png,"LUNA - USO DE CONTEXTO",52,42,4,fg);
  text(png,ctx.model,54,88,2,muted);

  rect(png,48,130,984,150,panel);
  text(png,"CONTEXTO ACTUAL",72,154,3,fg);
  const usagePct=clamp(ctx.percentOfInputBudget,0,100);
  text(png,`${fmt(ctx.estimatedTotalTokens)} / ${fmt(ctx.effectiveInputBudget)} TOKENS`,72,202,3,fg);
  text(png,pct(usagePct),840,202,3,usagePct>=80?amber:green);
  rect(png,72,246,900,18,barBg);
  rect(png,72,246,Math.round(900*usagePct/100),18,usagePct>=80?amber:accent);

  rect(png,48,306,984,350,panel);
  text(png,"DESGLOSE ESTIMADO DEL CONTEXTO BASE",72,330,2,fg);
  let y=374;
  for (const [label,value] of breakdownRows(ctx)) {
    text(png,label,72,y,2,muted);
    text(png,fmt(value),760,y,2,fg);
    const share=ctx.estimatedTotalTokens>0?value/ctx.estimatedTotalTokens:0;
    rect(png,875,y+2,110,10,barBg); rect(png,875,y+2,Math.round(110*clamp(share,0,1)),10,accent);
    y+=36;
  }

  rect(png,48,682,480,190,panel);
  text(png,"CONSUMO API ACUMULADO",72,706,2,fg);
  text(png,`ENTRADA  ${fmt(data.lifetime.promptTokens)}`,72,748,2,fg);
  text(png,`SALIDA   ${fmt(data.lifetime.completionTokens)}`,72,784,2,fg);
  text(png,`REQUESTS ${fmt(data.lifetime.requests)}`,72,820,2,fg);
  text(png,`REAL ${data.lifetime.providerReportedRequests}  MIXTO ${data.lifetime.mixedRequests}  EST ${data.lifetime.estimatedRequests}`,72,850,1,muted);

  rect(png,552,682,480,190,panel);
  text(png,"COMPACTACION",576,706,2,fg);
  text(png,`TOTAL ${data.compaction.count}`,576,748,2,fg);
  text(png,`MENSAJES ${fmt(data.compaction.messagesCompacted)}`,576,784,2,fg);
  text(png,`ULTIMA REDUCCION ${pct(data.compaction.lastReductionPercent)}`,576,820,2,fg);
  text(png,`AUTO-COMPACT ${fmt(ctx.autoCompactTriggerTokens)} TOKENS`,576,850,1,muted);

  return PNG.sync.write(png);
}
