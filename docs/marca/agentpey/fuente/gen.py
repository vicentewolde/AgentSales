import os, subprocess, sys
OUT = os.path.dirname(os.path.abspath(__file__))
FONTS = '<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">'
_n = [0]
def mark_inner(stroke):
    _n[0] += 1
    m = f"apm{_n[0]}"
    return (f'<defs><mask id="{m}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="#fff"/>'
            f'<path d="M378 112l54 54" stroke="#000" stroke-width="60"/></mask></defs>'
            f'<g mask="url(#{m})" fill="none" stroke="{stroke}" stroke-width="60"><path d="M72 416 196 96h86v320"/><path d="M136 282h146"/><path d="M282 112h96"/><path d="M432 166v84l-48 48H282"/></g>')
def mark(stroke, cut=None):
    return f'<svg viewBox="0 0 512 512" aria-hidden="true">{mark_inner(stroke)}</svg>'
BASE = """
:root{--black:#000;--fog:#f5f5f7;--ink:#1d1d1f;--gray:#6e6e73;--gray-dark:#86868b;--blue:#176bff;--blue-dark:#2997ff;--mint:#6df2c0;--hair:#d2d2d7}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:"Inter",-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.display{font-family:"Inter Tight","Inter",system-ui,sans-serif;font-weight:600;letter-spacing:-.022em;line-height:1.04;text-wrap:balance}
.wm{display:flex;align-items:center;gap:14px;font-family:"Inter Tight";font-weight:600;font-size:34px;letter-spacing:-.02em}
.wm svg{width:40px;height:40px}
.medal{border-radius:50%;display:grid;place-items:center;
 background:conic-gradient(from 200deg,#f5f5f7,#9aa3ad 12%,#ffffff 26%,#7d8590 40%,#e8ebef 55%,#a7b0ba 70%,#ffffff 85%,#f5f5f7);
 box-shadow:inset 0 0 0 2px rgba(255,255,255,.7),inset 0 -6px 18px rgba(0,0,0,.25)}
.medal .in{border-radius:50%;display:grid;place-items:center;
 background:radial-gradient(circle at 34% 28%,#5b9dff 0%,#176bff 42%,#0b3fb0 100%);
 box-shadow:inset 0 12px 30px rgba(255,255,255,.28),inset 0 -24px 44px rgba(0,0,0,.38),0 2px 0 rgba(255,255,255,.4)}
"""
def page(css, body):
    return f'<!doctype html><html lang="en"><head><meta charset="utf-8">{FONTS}<style>{BASE}{css}</style></head><body>{body}</body></html>'

designs = {}

# X · A: keynote oscuro con medalla
designs["x-a-keynote"] = page("""
body{background:var(--black);color:#fff}
.glow{position:absolute;left:50%;top:440px;width:760px;height:760px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(23,107,255,.30),rgba(23,107,255,0) 60%)}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:88px 80px 72px;text-align:center}
.wm{color:#f5f5f7}
.medal{width:360px;height:360px;margin-top:auto;position:relative;background:linear-gradient(150deg,#fdfdfe 0%,#c3c9d0 35%,#f2f4f6 55%,#8e97a1 100%);box-shadow:0 40px 90px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.9),inset 0 -2px 6px rgba(0,0,0,.3)}
.medal .in{width:300px;height:300px;background:radial-gradient(circle at 50% 22%,#4d95ff 0%,#176bff 45%,#0a2f86 100%)}
.medal .in svg{width:116px;height:116px}
h1{margin-top:84px;font-size:110px;letter-spacing:-.028em;color:#f5f5f7}
h1 .g{background:linear-gradient(90deg,#2997ff 0%,#6df2c0 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:34px;font-size:38px;line-height:1.25;color:var(--gray-dark);font-weight:500;letter-spacing:-.005em}
.foot{margin-top:auto;font-size:28px;color:var(--gray-dark)}
""", f"""<div class="glow"></div><div class="wrap">
<div class="wm">{mark('#f5f5f7','#000')}AgentPey</div>
<div class="medal"><div class="in">{mark('#fff','#176bff')}</div></div>
<h1 class="display">We won the<br><span class="g">Stellar Instawards.</span></h1>
<p class="sub">Thank you, Stellar, for the support.<br>We keep building.</p>
<p class="foot">@agentpeyai</p></div>""")

# X · B: newsroom claro con bento
designs["x-b-bento"] = page("""
body{background:var(--fog);color:var(--ink)}
.wrap{position:absolute;inset:0;padding:90px 80px 80px;display:flex;flex-direction:column}
.wm{color:var(--ink)}
.eyebrow{margin-top:120px;font-size:32px;font-weight:600;color:var(--blue);letter-spacing:-.01em}
h1{margin-top:20px;font-size:112px}
.grid{margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:22px;height:590px}
.tile{border-radius:36px;padding:44px;display:flex;flex-direction:column}
.dark{background:#000;color:#f5f5f7;align-items:center;justify-content:center;gap:30px}
.dark .medal{width:250px;height:250px}.dark .medal .in{width:196px;height:196px}.dark .medal .in svg{width:88px;height:88px}
.dark .cap{font-family:"Inter Tight";font-weight:600;font-size:34px;letter-spacing:-.02em;text-align:center;line-height:1.15}
.dark .cap span{display:block;color:var(--gray-dark);font-size:26px;font-weight:500;letter-spacing:0;margin-top:6px}
.light{background:#fff}
.light p{font-family:"Inter Tight";font-weight:600;font-size:52px;line-height:1.1;letter-spacing:-.02em;text-wrap:balance}
.light p span{color:var(--gray)}
.light .h{margin-top:auto;font-size:28px;font-weight:600;color:var(--blue)}
""", f"""<div class="wrap">
<div class="wm">{mark('#1d1d1f','#f5f5f7')}AgentPey</div>
<p class="eyebrow">Big news</p>
<h1 class="display">We won the<br>Stellar Instawards.</h1>
<div class="grid">
 <div class="tile dark"><div class="medal"><div class="in">{mark('#fff','#176bff')}</div></div><p class="cap">Stellar Instawards<span>Winner</span></p></div>
 <div class="tile light"><p>Thank you, Stellar, for the support.<br><span>We keep building.</span></p><p class="h">@agentpeyai</p></div>
</div></div>""")

# IG · A: bento claro «Meet AgentPey.»
designs["ig-a-bento"] = page("""
body{background:var(--fog);color:var(--ink)}
.wrap{position:absolute;inset:0;padding:88px 80px 72px;display:flex;flex-direction:column;align-items:center;text-align:center}
.wm{color:var(--ink)}
h1{margin-top:64px;font-size:120px;letter-spacing:-.03em}
.sub{margin-top:18px;font-size:42px;font-weight:500;color:var(--gray);letter-spacing:-.015em}
.grid{margin-top:64px;width:100%;display:grid;grid-template-columns:1fr 1fr;gap:22px;text-align:left}
.tile{background:#fff;border-radius:34px;padding:44px 44px 48px;display:flex;flex-direction:column;justify-content:flex-start}
.wide:last-child{padding:38px 44px}
.tile .k{font-size:24px;font-weight:600;color:var(--gray);letter-spacing:0}
.tile .t{margin-top:10px;font-family:"Inter Tight";font-weight:600;font-size:45px;line-height:1.1;letter-spacing:-.01em;text-wrap:balance}
.wide{grid-column:span 2}
.dark{background:#000;color:#f5f5f7}.dark .k{color:var(--gray-dark)}
.dark .t .b{color:var(--blue-dark)}
.foot{margin-top:auto;font-size:28px;color:var(--gray)}
""", f"""<div class="wrap">
<div class="wm">{mark('#1d1d1f','#f5f5f7')}AgentPey</div>
<h1 class="display">Meet AgentPey.</h1>
<p class="sub">Agents buy. You stay in charge.</p>
<div class="grid">
 <div class="tile dark wide"><p class="k">Payments</p><p class="t">Your AI agent shops online and pays in <span class="b">USDC on Stellar.</span></p></div>
 <div class="tile"><p class="k">Limits</p><p class="t">Spending limits enforced by a contract.</p></div>
 <div class="tile"><p class="k">Receipts</p><p class="t">A signed receipt for every purchase.</p></div>
 <div class="tile wide"><p class="k">Works with</p><p class="t">Claude and ChatGPT, through MCP.</p></div>
</div>
<p class="foot">Running on testnet · agentpey.com</p></div>""")

# IG · B: keynote oscuro con anillos de límite
designs["ig-b-rings"] = page("""
body{background:var(--black);color:#f5f5f7}
.wrap{position:absolute;inset:0;padding:88px 90px 78px;display:flex;flex-direction:column;align-items:center;text-align:center}
.wm{color:#f5f5f7}
h1{margin-top:70px;font-size:128px}
h1 .g{background:linear-gradient(90deg,#2997ff,#6df2c0);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:18px;font-size:42px;font-weight:500;color:var(--gray-dark);letter-spacing:-.015em}
.rings{margin-top:56px;width:330px;height:330px}
.list{margin-top:56px;width:100%;text-align:left}
.row{display:flex;align-items:center;gap:26px;padding:24px 4px;border-top:1px solid #2a2a2c}
.row:last-child{border-bottom:1px solid #2a2a2c}
.row svg{width:44px;height:44px;flex:none;color:var(--blue-dark)}
.row p{font-family:"Inter Tight";font-weight:600;font-size:40px;letter-spacing:-.025em}
.foot{margin-top:auto;font-size:24px;color:var(--gray-dark)}
""", f"""<div class="wrap">
<div class="wm">{mark('#f5f5f7','#000')}AgentPey</div>
<h1 class="display">Meet <span class="g">AgentPey.</span></h1>
<p class="sub">Agents buy. You stay in charge.</p>
<svg class="rings" viewBox="0 0 200 200" aria-hidden="true">
 <circle cx="100" cy="100" r="86" fill="none" stroke="#0d2a5c" stroke-width="20"/>
 <circle cx="100" cy="100" r="86" fill="none" stroke="#2997ff" stroke-width="20" stroke-linecap="round" stroke-dasharray="380 541" transform="rotate(-90 100 100)"/>
 <circle cx="100" cy="100" r="62" fill="none" stroke="#123d33" stroke-width="20"/>
 <circle cx="100" cy="100" r="62" fill="none" stroke="#6df2c0" stroke-width="20" stroke-linecap="round" stroke-dasharray="230 390" transform="rotate(-90 100 100)"/>
 <g transform="translate(70 70) scale(.117)">{mark_inner('#f5f5f7')}</g>
</svg>
<div class="list">
 <div class="row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8M12 16v1.5"/></svg><p>Pays in USDC on Stellar</p></div>
 <div class="row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg><p>Limits enforced by a contract</p></div>
 <div class="row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg><p>A signed receipt for every purchase</p></div>
</div>
<p class="foot">Running on testnet · agentpey.com</p></div>""")


# Versiones en español (mismo diseño, mismos hechos)
designs["x-a-keynote-es"] = (designs["x-a-keynote"]
  .replace('<html lang="en">','<html lang="es">')
  .replace('We won the<br><span class="g">Stellar Instawards.</span>','Ganamos los<br><span class="g">Stellar Instawards.</span>')
  .replace('Thank you, Stellar, for the support.<br>We keep building.','Gracias, Stellar, por el apoyo.<br>Seguimos construyendo.'))
designs["ig-a-bento-es"] = (designs["ig-a-bento"]
  .replace('<html lang="en">','<html lang="es">')
  .replace('Meet AgentPey.','Conoce AgentPey.')
  .replace('Agents buy. You stay in charge.','Los agentes compran. Tú sigues al mando.')
  .replace('<p class="k">Payments</p><p class="t">Your AI agent shops online and pays in <span class="b">USDC on Stellar.</span></p>','<p class="k">Pagos</p><p class="t">Tu agente de IA compra online y paga en <span class="b">USDC sobre Stellar.</span></p>')
  .replace('<p class="k">Limits</p><p class="t">Spending limits enforced by a contract.</p>','<p class="k">Límites</p><p class="t">Límites de gasto que hace cumplir un contrato.</p>')
  .replace('<p class="k">Receipts</p><p class="t">A signed receipt for every purchase.</p>','<p class="k">Recibos</p><p class="t">Un recibo firmado por cada compra.</p>')
  .replace('<p class="k">Works with</p><p class="t">Claude and ChatGPT, through MCP.</p>','<p class="k">Funciona con</p><p class="t">Claude y ChatGPT, por MCP.</p>')
  .replace('Running on testnet · agentpey.com','Corre en testnet · agentpey.com')
  .replace('h1{margin-top:64px;font-size:120px;letter-spacing:-.03em}','h1{margin-top:64px;font-size:104px;letter-spacing:-.03em;white-space:nowrap}'))
for _k in ("x-a-keynote-es","ig-a-bento-es"):
    assert designs[_k] != designs[_k.replace("-es","")]

only = sys.argv[1:] or list(designs)
for name in only:
    html = os.path.join(OUT, name + ".html"); png = os.path.join(OUT, name + ".png")
    open(html, "w").write(designs[name])
    subprocess.run(["/usr/bin/google-chrome","--headless=new","--no-sandbox","--disable-gpu","--hide-scrollbars","--window-size=1080,1350","--virtual-time-budget=12000",f"--screenshot={png}","file://"+html],capture_output=True,timeout=90)
    print(name, os.path.getsize(png))
