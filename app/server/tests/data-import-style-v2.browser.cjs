// Isolated real HTML/CSS only: import/export handlers are inert test spies, all
// network is blocked. Verify six equal columns against the pre-six-column backup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const baselineRoot = process.env.IMPORT_STYLE_BASELINE;
if (!baselineRoot) throw new Error('Set IMPORT_STYLE_BASELINE to an explicitly supplied historical baseline.');
const metricsOnly = process.argv.includes('--metrics-only');
const expected = [
  {kind:'import', value:'WTC3', icon:'', logo:true, title:'扫描/规划文件', description:'DATYaudio 原生格式', formats:['.csv','.scan']},
  {kind:'import', value:'WWB CSV', icon:'📁', title:'Wireless Workbench 扫描 CSV', description:'从 WWB 导出的频谱数据；不解析私有 Show 文件', formats:['.csv']},
  {kind:'import', value:'CSV', icon:'📄', title:'通用 CSV 数据', description:'标准频率列表格式', formats:['.csv']},
  {kind:'export', value:'csv', icon:'📊', title:'导出频率方案 (CSV)', description:'当前规划结果导出为标准 CSV 格式，含通道、频率、品牌信息', formats:['.csv']},
  {kind:'export', value:'json', icon:'🗂️', title:'导出完整方案 (JSON)', description:'含扫描数据+频率规划+设备信息，完整备份', formats:['.json']},
  {kind:'export', value:'report', icon:'📋', title:'导出演出报告 (HTML)', description:'生成精美 HTML 报告，含所有历史数据与图表', formats:['.html']}
];

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  const context = await browser.newContext();
  const unexpectedRequests = [], errors = [], dialogs = [];
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'daty-data-import-style-v2-'));
  try {
    await context.route('**/*', route => {unexpectedRequests.push(route.request().url());return route.abort();});
    async function fixture(sourceRoot) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => {dialogs.push(dialog.message());await dialog.dismiss();});
      const raw = fs.readFileSync(path.join(sourceRoot, 'unirf-app.html'), 'utf8');
      const styles = [...raw.matchAll(/<link\b[^>]*href="([^"?#]+\.css)(?:\?[^"#]*)?"[^>]*>/gi)].map(match => {
        const candidate = path.join(sourceRoot, match[1]);
        return fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(root, match[1]), 'utf8').replace(/^\uFEFF/, '');
      });
      assert.ok(styles.length, 'Use actual application stylesheets.');
      // Validate the deployed URL before replacing this one real image with its
      // exact PNG bytes, so an offline fixture cannot mask a broken production URL.
      const logoTags=[...raw.matchAll(/<img\b[^>]*class="data-import-style-logo"[^>]*>/gi)];
      if(sourceRoot===root) {
        assert.equal(logoTags.length,1, 'Only the first card uses the requested image asset.');
        assert.match(logoTags[0][0], /\bsrc="src\/assets\/daty-audio-logo\.png"/);
      }
      let fixtureRaw=raw;
      for(const match of logoTags) {
        const imagePath=/\bsrc="([^"]+)"/.exec(match[0])[1];
        const candidate=path.join(sourceRoot,imagePath);
        const png=fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(root,imagePath));
        assert.deepEqual([...png.subarray(0,8)], [137,80,78,71,13,10,26,10], 'Read the actual PNG asset.');
        fixtureRaw=fixtureRaw.replace(match[0],match[0].replace(`src="${imagePath}"`, `src="data:image/png;base64,${png.toString('base64')}"`));
      }
      await page.setContent(fixtureRaw.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<link\b[^>]*>/gi, ''));
      for (const content of styles) await page.addStyleTag({content});
      await page.evaluate(() => {
        window.fixtureActions = [];
        window.importFile = value => fixtureActions.push({kind:'import',value});
        window.exportData = value => fixtureActions.push({kind:'export',value});
        document.querySelectorAll('.panel,.tab-panel,.nav-item').forEach(node => node.classList.remove('active'));
        document.getElementById('panel-data').classList.add('active');
        document.getElementById('dataImport').classList.add('active');
        document.querySelectorAll('#panel-data > .tabs .tab').forEach((node,index) => node.classList.toggle('active', index === 1));
        document.querySelector('.nav-item[onclick*="\'data\'"]').classList.add('active');
        document.getElementById('pageTitle').textContent = '💾 数据管理';
      });
      return page;
    }
    const baseline = await fixture(baselineRoot);
    const page = await fixture(root);
    const cards = page.locator('#dataImport .data-import-style-card');
    assert.equal(await cards.count(), 6);
    assert.equal(await page.locator('#dataImport > .data-import-style-grid').count(), 1, 'The shared grid owns the six-column layout.');
    assert.equal(await page.locator('#dataImport > div').getAttribute('style'), null, 'No obsolete inline auto-fill declaration overrides the six-column layout.');
    assert.equal(await page.locator('#fasheConnCard').evaluate(node => node.outerHTML), await baseline.locator('#fasheConnCard').evaluate(node => node.outerHTML), 'FAshe connection card DOM is unchanged.');
    for (const [index,item] of expected.entries()) {
      const card = cards.nth(index);
      assert.equal(await card.evaluate(node => node.tagName), 'DIV');
      assert.equal((await card.locator('.data-import-style-icon').textContent()).trim(), item.icon);
      assert.equal(await card.locator('.data-import-style-icon').getAttribute('aria-hidden'), 'true');
      if(item.logo) {
        const logo=card.locator('img.data-import-style-logo');
        assert.equal(await logo.count(),1);
        assert.equal(await logo.getAttribute('alt'),'');
        assert.equal(await logo.getAttribute('width'),'48');
        assert.equal(await logo.getAttribute('height'),'48');
        assert.equal(await logo.getAttribute('draggable'),'false');
        assert.equal(await logo.evaluate(node=>node.complete && node.naturalWidth>0 && node.naturalHeight>0),true, 'The supplied logo decodes successfully.');
      } else assert.equal(await card.locator('img').count(),0);
      assert.equal((await card.locator('.data-import-style-title').textContent()).trim(), item.title);
      assert.equal((await card.locator('.data-import-style-description').textContent()).trim(), item.description);
      assert.deepEqual(await card.locator('.data-import-style-format').allTextContents(), item.formats);
      assert.ok((await card.getAttribute('class')).includes(item.kind === 'import' ? 'data-import-card' : 'data-export-card'));
      assert.equal(await card.getAttribute('onclick'), `${item.kind === 'import' ? 'importFile' : 'exportData'}('${item.value}')`);
    }
    async function connection(target, connected) {
      await target.evaluate(connected => {
        document.getElementById('fasheLastUpdate').style.display = connected ? 'block' : 'none';
        document.getElementById('fasheLastTime').textContent = '2026-09-11 09:00:00';
        document.getElementById('fasheDevCount').style.display = connected ? 'inline' : 'none';
        document.getElementById('fasheDevCount').textContent = '4 通道';
        document.getElementById('fasheStatusText').textContent = connected ? '已连接（隔离显示测试）' : '未连接';
        document.getElementById('fasheConnBtn').textContent = connected ? '断开接收' : '🔌 开始接收';
        document.querySelector('.content').scrollTop = 0;
      }, connected);
      await target.mouse.move(0, 0);
      await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function measurements(target) {
      return target.evaluate(() => {
        const box = node => {const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        const style = node => {const s=getComputedStyle(node);return Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','borderTopColor','borderTopStyle','borderTopWidth','borderRadius','textAlign','paddingTop','paddingRight','paddingBottom','paddingLeft'].map(key => [key,s[key]]));};
        const clippedText = node => {
          const range=document.createRange();range.selectNodeContents(node);
          const r=box(node), text=range.getBoundingClientRect(), s=getComputedStyle(node);
          return {text:node.textContent.trim(), clipped:node.scrollHeight>node.clientHeight+1 || node.scrollWidth>node.clientWidth+1 || text.left<r.x-1 || text.right>r.right+1 || text.top<r.y-1 || text.bottom>r.bottom+1 || s.textOverflow==='ellipsis' || !['none','0'].includes(s.webkitLineClamp)};
        };
        const cards=[...document.querySelectorAll('#dataImport .data-import-style-card')].map(node => ({
          rect:box(node),style:style(node),icon:box(node.querySelector('.data-import-style-icon')),
          iconStyle:style(node.querySelector('.data-import-style-icon')),titleStyle:style(node.querySelector('.data-import-style-title')),
          logo:node.querySelector('img.data-import-style-logo') ? {rect:box(node.querySelector('img.data-import-style-logo')),objectFit:getComputedStyle(node.querySelector('img.data-import-style-logo')).objectFit,display:getComputedStyle(node.querySelector('img.data-import-style-logo')).display} : null,
          descriptionStyle:style(node.querySelector('.data-import-style-description')),titleRect:box(node.querySelector('.data-import-style-title')),
          descriptionRect:box(node.querySelector('.data-import-style-description')),formatsRect:box(node.querySelector('.data-import-style-formats')),
          formats:[...node.querySelectorAll('.data-import-style-format')].map(style),
          text:[...node.querySelectorAll('.data-import-style-title,.data-import-style-description')].map(clippedText)
        }));
        const overflow=['html','body','.main','.content','#panel-data','#dataImport','#dataImport > div'].map(selector => {
          const node=document.querySelector(selector), s=getComputedStyle(node);
          return {selector,client:[node.clientWidth,node.clientHeight],scroll:[node.scrollWidth,node.scrollHeight],overflowX:s.overflowX,overflowY:s.overflowY};
        });
        const grid=document.querySelector('#dataImport > div');
        return {cards,overflow,grid:box(grid),columns:getComputedStyle(grid).gridTemplateColumns.split(' '),connection:box(document.getElementById('fasheConnCard'))};
      });
    }
    for (const [width,height] of [[1920,1080],[1366,768],[1280,720],[1024,600]]) {
      await baseline.setViewportSize({width,height});
      await page.setViewportSize({width,height});
      for (const connected of [false,true]) {
        await connection(baseline, connected);
        await connection(page, connected);
        const before = await measurements(baseline), state = await measurements(page);
        const label = `${width}x${height}-${connected ? 'connected' : 'disconnected'}`;
        const baselineContent = before.overflow.find(item => item.selector === '.content'), content = state.overflow.find(item => item.selector === '.content');
        console.log(JSON.stringify({label,baselineContent,currentContent:content,baselineGrid:before.overflow.at(-1),currentGrid:state.overflow.at(-1),cardSize:state.cards.map(card=>[card.rect.width,card.rect.height])}));
        if (metricsOnly) continue;
        await page.screenshot({path:path.join(output, `${label}.png`)});
        assert.ok(content.scroll[1] <= Math.max(baselineContent.scroll[1], content.client[1])+1, `${label}: do not increase existing vertical overflow.`);
        assert.deepEqual(state.overflow.filter(({client,scroll})=>scroll[0]>client[0]+1), [], `${label}: no horizontal overflow.`);
        assert.equal(state.columns.length,6, `${label}: six explicit equal-width columns.`);
        const first = state.cards[0];
        for (const [index,card] of state.cards.entries()) {
          assert.ok(Math.abs(card.rect.y-first.rect.y)<=1, `${label}/${index}: all six cards occupy one row.`);
          assert.ok(card.rect.x>=0 && card.rect.right<=width+1 && card.rect.y>=0 && card.rect.bottom<=height+1, `${label}/${index}: entire card fits the viewport.`);
          if(index) assert.ok(card.rect.x>=state.cards[index-1].rect.right, `${label}/${index}: card columns never overlap.`);
          assert.ok(Math.abs(card.rect.width-first.rect.width)<=1, `${label}/${index}: equal widths.`);
          assert.ok(Math.abs(card.rect.height-first.rect.height)<=1, `${label}/${index}: equal heights.`);
          for (const key of ['style','iconStyle','titleStyle','descriptionStyle']) assert.deepEqual(card[key], first[key], `${label}/${index}: common ${key}.`);
          assert.deepEqual([card.icon.width,card.icon.height], [56,56], `${label}/${index}: fixed icon region.`);
          if(index===0) {
            assert.deepEqual([card.logo.rect.width,card.logo.rect.height],[48,48], `${label}: first logo is 20 percent larger, within the unchanged 56px icon region.`);
            assert.equal(card.logo.objectFit,'contain', `${label}: the original logo is not cropped or distorted.`);
            assert.equal(card.logo.display,'block');
          }
          assert.equal(card.iconStyle.fontSize, '40px');
          assert.equal(card.titleStyle.fontSize, width<=1450 ? '14px' : '16px');
          assert.equal(card.titleStyle.fontWeight, '700');
          assert.equal(card.titleStyle.lineHeight, width<=1450 ? '20px' : '24px');
          assert.equal(card.descriptionStyle.fontSize, width<=1100 ? '11px' : '12px');
          assert.equal(card.descriptionStyle.lineHeight, width<=1100 ? '16px' : '18px');
          for (const key of ['icon','titleRect','descriptionRect','formatsRect']) assert.ok(Math.abs((card[key].y-card.rect.y)-(first[key].y-first.rect.y))<=1, `${label}/${index}: ${key} alignment.`);
          for (const format of card.formats) {assert.deepEqual(format,first.formats[0]);assert.equal(format.fontSize,'10px');}
          assert.deepEqual(card.text.filter(item=>item.clipped), [], `${label}/${index}: no truncation.`);
        }
        assert.ok(Math.abs(state.connection.width-state.grid.width)<=1, `${label}: FAshe remains full-width below all six columns.`);
        assert.ok(state.connection.y>=first.rect.bottom, `${label}: FAshe connection occupies the next row.`);
        // Final controls must remain reachable, never hidden to pass overflow checks.
        await page.locator('#fasheConnBtn').scrollIntoViewIfNeeded();
        const reachable = await page.locator('#fasheConnBtn').evaluate(node => {const r=node.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight+1;});
        assert.equal(reachable,true, `${label}: FAshe controls remain reachable.`);
      }
    }
    if (!metricsOnly) {
      await page.setViewportSize({width:1366,height:768});
      for (const [index,item] of expected.entries()) {
        await page.evaluate(() => {fixtureActions.length=0;});
        await cards.nth(index).click();
        assert.deepEqual(await page.evaluate(() => fixtureActions), [{kind:item.kind,value:item.value}], `${item.value}: preserve exact single mouse activation.`);
      }
    }
    assert.deepEqual(unexpectedRequests, [], 'No network or production API requests.');
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
    console.log(`${metricsOnly ? 'METRICS' : 'PASS'}: six equal import/export cards in one row; readable text; original content, icons, handlers and FAshe DOM preserved. Screenshots: ${output}`);
  } catch (error) {
    console.error('Screenshots: ' + output);
    throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
