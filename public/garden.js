// garden.js — Standalone animated garden renderer
// Usage: initGarden('canvasId', { fitParent: true })

function getET() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(s);
}
function getETHour() { return getET().getHours(); }
function getETMinute() { return getET().getMinutes(); }
function getETMonth() { return getET().getMonth(); }
function getETTimeF() { return getETHour() + getETMinute() / 60; }

var gardenSunTimes = window.gardenSunTimes || { sunrise: 6.5, sunset: 19.5, dawnStart: 6, duskEnd: 20 };

function initGarden(canvasId, opts) {
  opts = opts || {};
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  function getTimeState() {
    var timeF = getETTimeF();
    var s = gardenSunTimes;
    return {
      timeF: timeF,
      isNight: timeF < s.dawnStart || timeF >= s.duskEnd,
      isDawn: timeF >= s.dawnStart && timeF < s.sunrise + 0.5,
      isDusk: timeF >= s.sunset - 0.5 && timeF < s.duskEnd,
      isMorning: timeF >= s.sunrise + 0.5 && timeF < 11,
      isNoon: timeF >= 11 && timeF < 14,
      isAfternoon: timeF >= 14 && timeF < s.sunset - 0.5,
      sunrise: s.sunrise, sunset: s.sunset, dawnStart: s.dawnStart, duskEnd: s.duskEnd
    };
  }

  var ts = getTimeState();
  var useNightBg = ts.isNight;
  var bgDay = new Image(), bgNight = new Image();
  var loadCount = 0;
  bgDay.src = '/garden-bg.jpg';
  bgNight.src = '/garden-night.jpg';
  function onBgLoad() { loadCount++; if (loadCount >= 2) startGarden(); }
  bgDay.onload = onBgLoad;
  bgNight.onload = onBgLoad;

  function startGarden() {
    var bgImg = useNightBg ? bgNight : bgDay;
    var ratio = bgImg.height / bgImg.width;
    // Reference resolution (all coordinates authored at this size)
    var REF_W = 820, REF_H = Math.round(820 * ratio);
    var cw, ch;
    if (opts.fitParent) {
      cw = canvas.parentElement.clientWidth;
      ch = canvas.parentElement.clientHeight;
    } else {
      cw = REF_W;
      ch = REF_H;
    }
    canvas.width = cw;
    canvas.height = ch;

    // Background draw params (scale-to-fill)
    var bgScale = Math.max(cw / bgImg.naturalWidth, ch / bgImg.naturalHeight);
    var bgDrawW = bgImg.naturalWidth * bgScale;
    var bgDrawH = bgImg.naturalHeight * bgScale;
    var bgOffX = (cw - bgDrawW) / 2;
    var bgOffY = (ch - bgDrawH) / 2;

    // Transform: map reference 820-space coordinates to actual canvas
    // All sparkle/light/moon positions are in 820-space
    function mapX(x) { return bgOffX + (x / REF_W) * bgDrawW; }
    function mapY(y) { return bgOffY + (y / REF_H) * bgDrawH; }
    function mapR(r) { return r * bgScale; }

    var timeF = ts.timeF, isNight = ts.isNight, isDawn = ts.isDawn, isDusk = ts.isDusk;
    var weatherDesc = '', showRain = false;

    function px(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

    // Bird sprites
    var birdSpeciesCfg = [
      { name: 'canary', frames: 4 }, { name: 'cardinal', frames: 2 },
      { name: 'chickadee', frames: 2 }, { name: 'oriole', frames: 3 }, { name: 'woodpecker', frames: 3 }
    ];
    var birdSpecies = birdSpeciesCfg.map(function(s){return s.name});
    var birdFrames = {}, birdImgsLoaded = 0, birdImgsTotal = 0;
    birdSpeciesCfg.forEach(function(sp) {
      birdFrames[sp.name] = [];
      birdImgsTotal += sp.frames;
      for (var f = 1; f <= sp.frames; f++) {
        var img = new Image();
        img.onload = function() { birdImgsLoaded++; };
        img.src = '/birds/' + sp.name + '/' + f + '.png';
        birdFrames[sp.name].push(img);
      }
    });

    var birds = [], birdTimer = 0, nextBirdSpawn = 300 + Math.random() * 600;
    var raindrops = [];
    for (var i = 0; i < 60; i++) raindrops.push({ x: Math.random()*cw, y: Math.random()*ch, speed: 4+Math.random()*4, len: 4+Math.random()*6 });

    var month = getETMonth();
    var isSummer = month >= 5 && month <= 8;
    var fireflies = [];
    for (var i = 0; i < (isSummer ? 5 : 0); i++) fireflies.push({ x:mapX(200+Math.random()*400), y:mapY(150+Math.random()*250), dx:(Math.random()-0.5)*0.3, dy:(Math.random()-0.5)*0.2, phase:Math.random()*Math.PI*2 });

    var sparklePoints = useNightBg
      ? [[478,385],[493,394],[500,415],[496,434],[470,438],[530,454]]
      : [[473,381],[494,398],[513,404],[499,423],[460,442],[478,458],[523,460],[528,452],[433,439],[579,449],[556,456]];
    var sparkles = sparklePoints.map(function(p){return{x:p[0],y:p[1],phase:Math.random()*Math.PI*2,speed:0.8+Math.random()*1.5}});

    var clouds = [
      {x:50,y:28,puffs:[{dx:0,dy:0,r:28},{dx:22,dy:-6,r:22},{dx:-18,dy:-3,r:20},{dx:38,dy:2,r:18},{dx:-8,dy:-10,r:16}],speed:0.18,opacity:0.6},
      {x:350,y:40,puffs:[{dx:0,dy:0,r:22},{dx:18,dy:-4,r:18},{dx:-14,dy:-2,r:16},{dx:30,dy:3,r:14}],speed:0.12,opacity:0.45},
      {x:600,y:18,puffs:[{dx:0,dy:0,r:32},{dx:26,dy:-8,r:26},{dx:-22,dy:-4,r:22},{dx:44,dy:2,r:20},{dx:10,dy:-14,r:18},{dx:-10,dy:-12,r:15}],speed:0.14,opacity:0.55},
      {x:200,y:55,puffs:[{dx:0,dy:0,r:18},{dx:14,dy:-3,r:14},{dx:-10,dy:-2,r:12}],speed:0.08,opacity:0.3}
    ];

    var frame = 0;

    window.gardenSetWeather = function(desc) { weatherDesc = (desc||'').toLowerCase(); showRain = !!weatherDesc.match(/rain|shower|drizzle|storm/); };
    window.gardenSetRain = function(r) { showRain = r; };

    function drawBird(x, y, bird) {
      if (birdImgsLoaded < birdImgsTotal) return;
      var frames = birdFrames[bird.species]; if (!frames || !frames.length) return;
      var fi = Math.floor(bird.wingPhase * 0.5) % frames.length;
      var img = frames[fi]; if (!img || !img.complete) return;
      var size = 30, r = img.height / img.width;
      ctx.drawImage(img, Math.round(x), Math.round(y - size*r/2), size, Math.round(size*r));
    }

    function getSunConfig() {
      var s = gardenSunTimes, dayLen = s.duskEnd - s.dawnStart;
      var progress = Math.max(0, Math.min(1, (timeF - s.dawnStart) / dayLen));
      var horizonY = mapY(82), sx = mapX(60) + progress * (mapX(760) - mapX(60));
      var arcH = Math.sin(progress * Math.PI), sy = horizonY - arcH * (horizonY - mapY(8));
      var size = mapR(14 + arcH * 6), edgeDist = Math.min(progress, 1 - progress);
      var sinkRatio = edgeDist < 0.1 ? 1 - (edgeDist / 0.1) : 0;
      var core, glow, rayColor, glowR, glowAlpha;
      if (edgeDist < 0.08) { core='#ff4020';glow='rgba(255,60,10,';rayColor='#ff5030';glowR=size*5;glowAlpha=0.25; }
      else if (edgeDist < 0.15) { core='#ff7030';glow='rgba(255,100,30,';rayColor='#ff8040';glowR=size*4;glowAlpha=0.2; }
      else if (edgeDist < 0.28) { core='#ffaa33';glow='rgba(255,170,50,';rayColor='#ffbb44';glowR=size*3.5;glowAlpha=0.18; }
      else { core='#fff4b0';glow='rgba(255,244,180,';rayColor='#ffe066';glowR=size*3;glowAlpha=0.15; }
      return {x:sx,y:sy,r:size,core:core,glow:glow,glowR:glowR,glowAlpha:glowAlpha,rayColor:rayColor,progress:progress,sinkRatio:sinkRatio,horizonY:horizonY};
    }

    function drawSkyGlow(sc) {
      var p=sc.progress, ed=Math.min(p,1-p);
      if (ed<0.18 && !isNight) {
        var isDG=p<0.5, int=Math.max(0,1-ed/0.18);
        var g=ctx.createRadialGradient(sc.x,sc.horizonY,0,sc.x,sc.horizonY,300);
        g.addColorStop(0,'rgba(255,'+(isDG?100:60)+',20,'+int*0.35+')');
        g.addColorStop(0.3,'rgba(255,'+(isDG?140:90)+',40,'+int*0.2+')');
        g.addColorStop(0.6,'rgba(255,180,80,'+int*0.08+')');
        g.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=g; ctx.fillRect(0,0,cw,sc.horizonY+40);
        var hG=ctx.createLinearGradient(0,sc.horizonY-30,0,sc.horizonY+20);
        hG.addColorStop(0,'rgba(0,0,0,0)');
        hG.addColorStop(0.4,'rgba(255,'+(isDG?80:50)+',20,'+int*0.2+')');
        hG.addColorStop(0.7,'rgba(255,'+(isDG?120:70)+',30,'+int*0.15+')');
        hG.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=hG; ctx.fillRect(0,sc.horizonY-30,cw,50);
      }
    }

    function drawSun(sc) {
      ctx.save();
      if (sc.sinkRatio > 0.01) { ctx.beginPath(); ctx.rect(0,0,cw,sc.horizonY); ctx.clip(); }
      var g1=ctx.createRadialGradient(sc.x,sc.y,sc.r*0.3,sc.x,sc.y,sc.glowR);
      g1.addColorStop(0,sc.glow+sc.glowAlpha+')');
      g1.addColorStop(0.4,sc.glow+(sc.glowAlpha*0.4)+')');
      g1.addColorStop(1,sc.glow+'0)');
      ctx.fillStyle=g1; ctx.beginPath(); ctx.arc(sc.x,sc.y,sc.glowR,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=sc.core; ctx.beginPath(); ctx.arc(sc.x,sc.y,sc.r,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(sc.x,sc.y,sc.r*0.45,0,Math.PI*2); ctx.fill();
      var rc=sc.sinkRatio>0.5?5:8;
      for(var a=0;a<rc;a++){var ang=(a/rc)*Math.PI*2+frame*0.004;if(sc.sinkRatio>0.3&&Math.sin(ang)>0.3)continue;var d1=sc.r+3,d2=sc.r+8;px(sc.x+Math.cos(ang)*d1,sc.y+Math.sin(ang)*d1,3,3,sc.rayColor);px(sc.x+Math.cos(ang)*d2,sc.y+Math.sin(ang)*d2,2,2,sc.rayColor);}
      ctx.restore();
      if(sc.sinkRatio>0.1){var ra=sc.sinkRatio*0.3;var rg=ctx.createRadialGradient(sc.x,sc.horizonY,0,sc.x,sc.horizonY,sc.r*3);rg.addColorStop(0,'rgba(255,100,30,'+ra+')');rg.addColorStop(0.5,'rgba(255,150,50,'+ra*0.4+')');rg.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=rg;ctx.fillRect(sc.x-sc.r*3,sc.horizonY-5,sc.r*6,20);}
    }

    function isSunVisible() { if(isNight)return false; if(weatherDesc.match(/rain|shower|drizzle|storm|thunder/))return false; if(weatherDesc.match(/cloudy|overcast/)&&!weatherDesc.match(/partly|mostly sunny/))return false; return true; }
    function isSunDimmed() { return !!weatherDesc.match(/partly cloudy|mostly cloudy|partly sunny/); }

    function getLunarPhase() { var kn=new Date(2000,0,6,18,14).getTime(),lc=29.53058867*24*3600*1000; return((Date.now()-kn)%lc)/lc; }

    function drawPixelMoon(x,y,r) {
      var phase=getLunarPhase(), fullness=1-Math.abs(phase-0.5)*2;
      ctx.fillStyle='rgba(200,215,240,'+(0.04+fullness*0.08)+')';
      ctx.beginPath();ctx.arc(x,y,r*3,0,Math.PI*2);ctx.fill();
      ctx.save();ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.clip();
      ctx.fillStyle='#e8e8d0';ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
      var sp=phase<0.5?phase*2:(1-phase)*2, so=r*2*(1-sp);
      if(sp<0.98){ctx.fillStyle='rgba(12,20,40,0.92)';if(phase<0.5){ctx.beginPath();ctx.arc(x-so,y,r*1.05,0,Math.PI*2);ctx.fill();}else{ctx.beginPath();ctx.arc(x+so,y,r*1.05,0,Math.PI*2);ctx.fill();}}
      ctx.fillStyle='rgba(180,180,160,0.15)';ctx.beginPath();ctx.arc(x-r*0.2,y-r*0.15,r*0.12,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(x+r*0.15,y+r*0.2,r*0.08,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(x-r*0.05,y+r*0.3,r*0.1,0,Math.PI*2);ctx.fill();
      ctx.restore();
      if(weatherDesc.match(/cloudy|overcast/)){var im=!!weatherDesc.match(/mostly cloudy|overcast/),ca=im?0.6:0.35,dr=(frame*0.15)%(r*6)-r*2;for(var ci=0;ci<4;ci++){var cx2=x+dr+ci*r*0.8-r,cy2=y+Math.sin(ci*1.5+frame*0.01)*r*0.3,cr=r*(0.5+ci*0.15);var cg=ctx.createRadialGradient(cx2,cy2,0,cx2,cy2,cr);cg.addColorStop(0,'rgba(50,55,75,'+ca+')');cg.addColorStop(0.6,'rgba(40,45,65,'+ca*0.5+')');cg.addColorStop(1,'rgba(30,35,55,0)');ctx.fillStyle=cg;ctx.beginPath();ctx.arc(cx2,cy2,cr,0,Math.PI*2);ctx.fill();}}
    }

    function drawCloud(c) {
      ctx.save();
      c.puffs.forEach(function(p){var cx2=c.x+p.dx,cy2=c.y+p.dy,r=p.r;var g=ctx.createRadialGradient(cx2,cy2,r*0.1,cx2,cy2,r);if(isNight){g.addColorStop(0,'rgba(80,90,120,'+c.opacity*0.6+')');g.addColorStop(0.6,'rgba(60,70,100,'+c.opacity*0.3+')');g.addColorStop(1,'rgba(40,50,80,0)');}else{g.addColorStop(0,'rgba(255,255,255,'+c.opacity+')');g.addColorStop(0.5,'rgba(240,245,255,'+c.opacity*0.5+')');g.addColorStop(1,'rgba(220,230,245,0)');}ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx2,cy2,r,0,Math.PI*2);ctx.fill();});
      ctx.restore();
    }

    function animate() {
      requestAnimationFrame(animate);
      frame++;

      // Resize for fitParent mode
      if (opts.fitParent) {
        var pw = canvas.parentElement.clientWidth, ph = canvas.parentElement.clientHeight;
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; cw = pw; ch = ph; }
      }

      // Draw background (scale to fill)
      var scl = Math.max(cw / bgImg.naturalWidth, ch / bgImg.naturalHeight);
      ctx.drawImage(bgImg, bgOffX, bgOffY, bgDrawW, bgDrawH);

      // Time overlays
      if(isNight){ctx.fillStyle='rgba(5,8,25,0.15)';ctx.fillRect(0,0,cw,ch);}
      else if(isDawn){ctx.fillStyle='rgba(80,40,15,0.12)';ctx.fillRect(0,0,cw,ch);}
      else if(isDusk){ctx.fillStyle='rgba(70,25,10,0.2)';ctx.fillRect(0,0,cw,ch);}

      // Sun or Moon
      if(isNight){
        drawPixelMoon(mapX(680),mapY(45),mapR(18));
        ctx.fillStyle='#fff';
        for(var i=0;i<30;i++){var sx2=(i*137.5+frame*0.02)%cw,sy2=(i*97.3)%(ch*0.3);ctx.globalAlpha=0.3+0.4*Math.sin(frame*0.05+i);px(sx2,sy2,1,1,'#fff');}
        ctx.globalAlpha=1;
      }else{
        var sc=getSunConfig();
        if(!showRain)drawSkyGlow(sc);
        if(isSunVisible()&&!showRain){if(isSunDimmed())ctx.globalAlpha=0.5;drawSun(sc);ctx.globalAlpha=1;}
      }

      // Clouds
      clouds.forEach(function(c){c.x+=c.speed;var mr=Math.max.apply(null,c.puffs.map(function(p){return p.dx+p.r}));if(c.x-40>cw+mr)c.x=-mr-40;drawCloud(c);});

      // Birds (daytime)
      if(!isNight){
        birdTimer++;
        if(birdTimer>=nextBirdSpawn&&birds.length<2){var cnt=Math.random()<0.6?1:2;for(var bi=0;bi<cnt;bi++)birds.push({x:cw+40+bi*50,y:20+Math.random()*80,speed:-(0.4+Math.random()*0.5),wingPhase:Math.random()*Math.PI*2,species:birdSpecies[Math.floor(Math.random()*birdSpecies.length)],glideOffset:Math.random()*Math.PI*2});birdTimer=0;nextBirdSpawn=500+Math.random()*1200;}
        for(var bi=birds.length-1;bi>=0;bi--){var b=birds[bi];b.x+=b.speed;b.wingPhase+=0.1;b.y+=Math.sin(b.wingPhase*0.3+b.glideOffset)*0.2;if(b.x<-50){birds.splice(bi,1);continue;}drawBird(b.x,b.y,b);}
      }

      // Fireflies (night)
      if(isNight){fireflies.forEach(function(f){f.x+=f.dx+Math.sin(frame*0.02+f.phase)*0.3;f.y+=f.dy+Math.cos(frame*0.015+f.phase)*0.2;f.phase+=0.03;if(f.x<100||f.x>cw-100)f.dx*=-1;if(f.y<80||f.y>ch-100)f.dy*=-1;var al=0.3+0.7*Math.abs(Math.sin(f.phase));ctx.fillStyle='rgba(170,255,170,'+al+')';ctx.fillRect(Math.round(f.x),Math.round(f.y),3,3);ctx.fillStyle='rgba(170,255,170,'+al*0.2+')';ctx.fillRect(Math.round(f.x)-3,Math.round(f.y)-3,9,9);});}

      // Night lights
      if(isNight){
        var lights=[{x:237,y:383,r:55,color:[255,180,80],flicker:0.15},{x:504,y:482,r:40,color:[255,190,100],flicker:0.1},{x:634,y:438,r:38,color:[255,185,90],flicker:0.12},{x:633,y:531,r:35,color:[255,190,100],flicker:0.1}];
        lights.forEach(function(l,i){
          var lx = mapX(l.x), ly = mapY(l.y), lr = mapR(l.r);
          var pulse=1+Math.sin(frame*0.04+i*1.7)*l.flicker, rr=lr*pulse;
          var g1=ctx.createRadialGradient(lx,ly,0,lx,ly,rr);
          g1.addColorStop(0,'rgba('+l.color.join(',')+',0.25)');g1.addColorStop(0.4,'rgba('+l.color.join(',')+',0.1)');g1.addColorStop(1,'rgba('+l.color.join(',')+',0)');
          ctx.fillStyle=g1;ctx.beginPath();ctx.arc(lx,ly,rr,0,Math.PI*2);ctx.fill();
          var g2=ctx.createRadialGradient(lx,ly,0,lx,ly,rr*0.3);
          g2.addColorStop(0,'rgba(255,240,200,0.35)');g2.addColorStop(1,'rgba(255,220,150,0)');
          ctx.fillStyle=g2;ctx.beginPath();ctx.arc(lx,ly,rr*0.3,0,Math.PI*2);ctx.fill();
        });
      }

      // Water sparkles
      sparkles.forEach(function(s){s.phase+=0.04*s.speed;var al=0.2+0.6*Math.abs(Math.sin(s.phase));var col=isNight?'rgba(100,150,200,'+al+')':'rgba(200,230,255,'+al+')';px(mapX(s.x),mapY(s.y),2,2,col);});

      // Rain
      if(showRain){ctx.strokeStyle='rgba(180,200,220,0.4)';ctx.lineWidth=1;raindrops.forEach(function(r){r.y+=r.speed;r.x-=r.speed*0.2;if(r.y>ch){r.y=-r.len;r.x=Math.random()*cw;}ctx.beginPath();ctx.moveTo(Math.round(r.x),Math.round(r.y));ctx.lineTo(Math.round(r.x+r.speed*0.2),Math.round(r.y+r.len));ctx.stroke();});}

      // Vignette
      var vg=ctx.createRadialGradient(cw/2,ch/2,ch*0.3,cw/2,ch/2,ch*0.8);
      vg.addColorStop(0,'rgba(0,0,0,0)');vg.addColorStop(1,isNight?'rgba(0,0,0,0.4)':'rgba(0,0,0,0.15)');
      ctx.fillStyle=vg;ctx.fillRect(0,0,cw,ch);
    }

    animate();
  }
}
