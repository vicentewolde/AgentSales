import os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "gen.py")).read()
exec(src[: src.index("designs = {}")])  # FONTS, mark, mark_inner, BASE, page
OUT = os.path.join(HERE, "opts")

def x_keynote(t, lang="en"):
    head = ("We won the", "Stellar Instawards.") if lang == "en" else ("Ganamos los", "Stellar Instawards.")
    sub = ("Thank you, Stellar, for the support.<br>We keep building." if lang == "en"
           else "Gracias, Stellar, por el apoyo.<br>Seguimos construyendo.")
    return page(f"""
body{{background:{t['bg']};color:{t['fg']}}}
.glow{{position:absolute;left:50%;top:470px;width:760px;height:760px;transform:translate(-50%,-50%);background:radial-gradient(circle,{t['glow']},rgba(0,0,0,0) 60%)}}
.wrap{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:124px 80px 112px;text-align:center}}
.wm{{color:{t['fg']}}}
.medal{{width:340px;height:340px;margin-top:auto;position:relative;background:{t['ring']};box-shadow:{t['medalShadow']},inset 0 1px 0 rgba(255,255,255,.9),inset 0 -2px 6px rgba(0,0,0,.3)}}
.medal .in{{width:284px;height:284px;background:{t['disc']}}}
.medal .in svg{{width:110px;height:110px}}
h1{{margin-top:80px;font-size:106px;letter-spacing:-.028em;color:{t['fg']}}}
h1 .g{{background:{t['grad']};-webkit-background-clip:text;background-clip:text;color:transparent}}
.sub{{margin-top:32px;font-size:38px;line-height:1.25;color:{t['muted']};font-weight:500;letter-spacing:-.005em}}
.foot{{margin-top:auto;font-size:28px;color:{t['muted']}}}
""", f"""<div class="glow"></div><div class="wrap">
<div class="wm">{mark(t['fg'])}AgentPey</div>
<div class="medal"><div class="in">{mark(t['discMark'])}</div></div>
<h1 class="display">{head[0]}<br><span class="g">{head[1]}</span></h1>
<p class="sub">{sub}</p>
<p class="foot">@agentpeyai</p></div>""")

SILVER = "linear-gradient(150deg,#fdfdfe 0%,#c3c9d0 35%,#f2f4f6 55%,#8e97a1 100%)"
BLUE_DISC = "radial-gradient(circle at 50% 22%,#4d95ff 0%,#176bff 45%,#0a2f86 100%)"
X_THEMES = {
 "a-medianoche": dict(bg="#000", fg="#f5f5f7", muted="#86868b", glow="rgba(23,107,255,.30)", ring=SILVER, disc=BLUE_DISC, discMark="#fff",
                      grad="linear-gradient(90deg,#2997ff,#6df2c0)", medalShadow="0 40px 90px rgba(0,0,0,.65)"),
 "b-azul-profundo": dict(bg="radial-gradient(120% 90% at 50% 30%,#123a8c 0%,#071a45 55%,#030b20 100%)", fg="#f5f5f7", muted="#a9b7d6", glow="rgba(109,242,192,.18)",
                      ring=SILVER, disc="radial-gradient(circle at 50% 22%,#ffffff 0%,#e9eef6 55%,#b9c4d3 100%)", discMark="#176bff",
                      grad="linear-gradient(90deg,#9cc4ff,#6df2c0)", medalShadow="0 40px 90px rgba(0,0,0,.55)"),
 "c-claro": dict(bg="#f5f5f7", fg="#1d1d1f", muted="#6e6e73", glow="rgba(23,107,255,.16)", ring=SILVER, disc=BLUE_DISC, discMark="#fff",
                      grad="linear-gradient(90deg,#176bff,#14b8a6)", medalShadow="0 30px 60px rgba(29,29,31,.18)"),
 "d-titanio": dict(bg="linear-gradient(180deg,#2a2a2d 0%,#141416 100%)", fg="#f5f5f7", muted="#98989d", glow="rgba(255,255,255,.07)",
                      ring="linear-gradient(150deg,#f4f1ec 0%,#a8a29a 35%,#e8e4de 55%,#6f6a64 100%)", disc="radial-gradient(circle at 50% 22%,#5a5a5f 0%,#2c2c2e 55%,#141416 100%)", discMark="#f5f5f7",
                      grad="linear-gradient(90deg,#e8e4de,#a8a29a)", medalShadow="0 40px 90px rgba(0,0,0,.6)"),
}

def ig_bento(t, lang="en"):
    T = {"en": dict(h="Meet AgentPey.", sub="Agents buy. You stay in charge.", k=["Payments","Limits","Receipts","Works with"],
                    t=["Your AI agent shops online and pays in <span class=\"b\">USDC on Stellar.</span>","Spending limits enforced by a contract.","A signed receipt for every purchase.","Claude and ChatGPT, through MCP."], foot="Running on testnet · agentpey.com", size=118),
         "es": dict(h="Conoce AgentPey.", sub="Los agentes compran. Tú sigues al mando.", k=["Pagos","Límites","Recibos","Funciona con"],
                    t=["Tu agente de IA compra online y paga en <span class=\"b\">USDC sobre Stellar.</span>","Límites de gasto que hace cumplir un contrato.","Un recibo firmado por cada compra.","Claude y ChatGPT, por MCP."], foot="Corre en testnet · agentpey.com", size=102)}[lang]
    return page(f"""
body{{background:{t['bg']};color:{t['fg']}}}
.wrap{{position:absolute;inset:0;padding:116px 80px 100px;display:flex;flex-direction:column;align-items:center;text-align:center}}
.wm{{color:{t['fg']}}}
h1{{margin-top:56px;font-size:{T['size']}px;letter-spacing:-.03em;white-space:nowrap}}
.sub{{margin-top:16px;font-size:40px;font-weight:500;color:{t['muted']};letter-spacing:-.015em}}
.grid{{margin-top:auto;width:100%;display:grid;grid-template-columns:1fr 1fr;gap:20px;text-align:left}}
.tile{{background:{t['tile']};color:{t['tileFg']};border-radius:34px;padding:38px 40px 42px;display:flex;flex-direction:column}}
.tile .k{{font-size:23px;font-weight:600;color:{t['tileMuted']}}}
.tile .t{{margin-top:10px;font-family:"Inter Tight";font-weight:600;font-size:42px;line-height:1.1;letter-spacing:-.01em;text-wrap:balance}}
.wide{{grid-column:span 2}}
.hero{{background:{t['hero']};color:{t['heroFg']}}}.hero .k{{color:{t['heroMuted']}}}
.hero .t .b{{color:{t['accent']}}}
.foot{{margin-top:44px;font-size:27px;color:{t['muted']}}}
""", f"""<div class="wrap">
<div class="wm">{mark(t['fg'])}AgentPey</div>
<h1 class="display">{T['h']}</h1>
<p class="sub">{T['sub']}</p>
<div class="grid">
 <div class="tile hero wide"><p class="k">{T['k'][0]}</p><p class="t">{T['t'][0]}</p></div>
 <div class="tile"><p class="k">{T['k'][1]}</p><p class="t">{T['t'][1]}</p></div>
 <div class="tile"><p class="k">{T['k'][2]}</p><p class="t">{T['t'][2]}</p></div>
 <div class="tile wide"><p class="k">{T['k'][3]}</p><p class="t">{T['t'][3]}</p></div>
</div>
<p class="foot">{T['foot']}</p></div>""")

IG_THEMES = {
 "a-claro": dict(bg="#f5f5f7", fg="#1d1d1f", muted="#6e6e73", tile="#fff", tileFg="#1d1d1f", tileMuted="#6e6e73", hero="#000", heroFg="#f5f5f7", heroMuted="#86868b", accent="#2997ff"),
 "b-oscuro": dict(bg="#000", fg="#f5f5f7", muted="#86868b", tile="#1c1c1e", tileFg="#f5f5f7", tileMuted="#98989d", hero="#176bff", heroFg="#fff", heroMuted="rgba(255,255,255,.75)", accent="#b9f7e2"),
 "c-azul": dict(bg="#f5f5f7", fg="#1d1d1f", muted="#6e6e73", tile="#fff", tileFg="#1d1d1f", tileMuted="#6e6e73", hero="#176bff", heroFg="#fff", heroMuted="rgba(255,255,255,.78)", accent="#b9f7e2"),
 "d-titanio": dict(bg="linear-gradient(180deg,#2a2a2d 0%,#141416 100%)", fg="#f5f5f7", muted="#98989d", tile="rgba(255,255,255,.06)", tileFg="#f5f5f7", tileMuted="#98989d", hero="#e8e4de", heroFg="#1d1d1f", heroMuted="#6e6a64", accent="#176bff"),
}

def render(name, html):
    h = os.path.join(OUT, name + ".html"); p = os.path.join(OUT, name + ".png")
    open(h, "w").write(html)
    subprocess.run(["/usr/bin/google-chrome","--headless=new","--no-sandbox","--disable-gpu","--hide-scrollbars","--window-size=1080,1350","--virtual-time-budget=12000",f"--screenshot={p}","file://"+h],capture_output=True,timeout=90)
    return p

def sheet(name, items):
    cells = "".join(f'<figure><img src="file://{p}"><figcaption>{label}</figcaption></figure>' for label, p in items)
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#e5e5ea;font-family:system-ui,sans-serif}}
.g{{display:grid;grid-template-columns:repeat(4,432px);gap:24px;padding:32px}}
figure{{margin:0}} img{{width:432px;height:540px;display:block;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.12)}}
figcaption{{margin-top:10px;font:600 22px system-ui;color:#1d1d1f;text-align:center}}
</style></head><body><div class="g">{cells}</div></body></html>"""
    h = os.path.join(OUT, name + ".html"); p = os.path.join(OUT, name + ".png")
    open(h, "w").write(html)
    subprocess.run(["/usr/bin/google-chrome","--headless=new","--no-sandbox","--disable-gpu","--hide-scrollbars","--allow-file-access-from-files","--window-size=1888,668","--virtual-time-budget=6000",f"--screenshot={p}","file://"+h],capture_output=True,timeout=90)
    return p

xs = [(k.split("-",1)[0].upper()+" · "+k.split("-",1)[1].replace("-"," "), render("x-"+k, x_keynote(t))) for k,t in X_THEMES.items()]
igs = [(k.split("-",1)[0].upper()+" · "+k.split("-",1)[1].replace("-"," "), render("ig-"+k, ig_bento(t))) for k,t in IG_THEMES.items()]
print(sheet("opciones-x", xs)); print(sheet("opciones-instagram", igs))
