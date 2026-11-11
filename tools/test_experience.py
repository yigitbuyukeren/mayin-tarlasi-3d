#!/usr/bin/env python3
"""Çevrimdışı mobil deneyimi gerçek Chromium etkileşimleriyle doğrular."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from test_browser import RuntimeLog, check, start_server

ROOT = Path(__file__).resolve().parents[1]


def snapshot(page):
    return page.evaluate("JSON.parse(localStorage.getItem('mt3d-v1-save'))")


def profile(page):
    return page.evaluate("JSON.parse(localStorage.getItem('mt3d-v1-profile'))")


def pause(page):
    page.evaluate("window.mt3dApp.pause()")
    page.locator('#start.show').wait_for()


def land(page):
    page.locator('#padFlag').tap()
    page.wait_for_function("() => Number.parseFloat(document.querySelector('#prog').style.width) > 0")


def lesson(page, text):
    page.wait_for_function("text => document.querySelector('#expCoach')?.textContent.includes(text)", arg=text)


def run():
    from playwright.sync_api import sync_playwright
    assets = ROOT / 'android/app/src/main/assets'
    check((assets / 'web/experience.js').is_file(), 'Önce çevrimdışı paket hazırlanmalı')
    server, port = start_server('127.0.0.1', 0, assets, 'index.html', True)
    origin = f'http://127.0.0.1:{port}'
    started = time.monotonic()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            try:
                context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
                page = context.new_page()
                log = RuntimeLog(page, origin, True)
                page.goto(origin)
                page.wait_for_function('() => !!window.mt3dApp')
                check(page.locator('#levels .lv').count() == 24, 'Kampanya 24 görev içermiyor')

                # İlk eğitimi butonlarla baştan sona oyna; otomatik atlama/test köprüsü yok.
                page.locator('#expTutorialBtn').tap()
                lesson(page, 'Güvenli iniş')
                land(page)
                lesson(page, 'İlk adım')
                page.locator('[data-dir="up"]').tap()
                lesson(page, 'Sayıları oku')
                page.locator('[data-dir="up"]').tap()
                lesson(page, 'Tehlikeyi işaretle')
                page.locator('#padFlag').tap()
                lesson(page, 'Sınırı keşfet')
                page.locator('[data-dir="left"]').tap()
                lesson(page, 'Dedektör')
                page.locator('#padScan').tap()
                lesson(page, 'Mantığını kullan')
                page.locator('[data-dir="left"]').tap()
                lesson(page, 'Çevreyi güvenle aç')
                page.locator('#padChord').tap()
                page.wait_for_function("() => document.querySelector('#msgTitle').textContent.includes('Keşfe hazırsın')")
                check(profile(page)['tutorialCompleted'] is True, 'Eğitim bitişi kaydedilmedi')
                page.keyboard.press('r')
                check('Çayır Kapısı' in page.locator('#lvlName').inner_text(), 'Eğitim bitişinde R kazanılamayan eğitim tahtası açtı')
                land(page)
                pause(page)
                check('yeniden' in page.locator('#expTutorialBtn').inner_text().lower(), 'Tamamlanan eğitim yeniden oyna durumuna geçmedi')

                page.locator('#expNavSettings').tap()
                page.locator('[data-setting="leftHanded"]').click()
                check(page.locator('body').evaluate("el => el.classList.contains('left-handed')"), 'Solak düzeni uygulanmadı')
                page.locator('[data-setting="confirmUnknown"]').click()
                page.locator('[data-setting="reduceMotion"]').click()
                settings = page.evaluate("JSON.parse(localStorage.getItem('mt3d-v1-settings'))")
                check(settings['leftHanded'] and not settings['confirmUnknown'] and settings['reduceMotion'], 'Ayarlar saklanmadı')

                # Günün inişi ve mayınları her denemede aynı; değişen dekor RNG'si etkilemez.
                mines = None
                for attempt in range(2):
                    page.locator('#expNavDaily').tap()
                    page.once('dialog', lambda dialog: dialog.accept())
                    page.locator('#expDailyBtn').tap()
                    land(page)
                    pause(page)
                    saved = snapshot(page)
                    check(saved['mode'] == 'gunluk' and saved['dayKey'], 'Günlük görev kaydı geçersiz')
                    if attempt == 0:
                        mines = saved['grid']['mines']
                    else:
                        check(saved['grid']['mines'] == mines, 'Aynı günün mayınları değişti')
                log.assert_clean('eğitim, ayarlar ve günlük görev')

                # Görünüm satın alımı yalnız yerel oyun altını kullanır; ödeme servisi yok.
                pause(page)
                page.evaluate("""() => {
                    const p = window.MT3D_PROGRESS.defaultProfile(); p.coins = 1000;
                    localStorage.setItem('mt3d-v1-profile', JSON.stringify(p));
                }""")
                page.reload()
                page.wait_for_function('() => !!window.mt3dApp')
                page.locator('#expNavWardrobe').tap()
                skin = page.evaluate("window.MT3D_PROGRESS.SKINS.find(s => s.cost > 0 && s.cost <= 1000)")
                check(skin, 'Satın alınabilir görünüm yok')
                page.locator('[data-buy-skin="' + skin['id'] + '"]').click()
                check(profile(page)['coins'] == 1000 - skin['cost'], 'Görünüm bedeli yanlış')
                page.locator('[data-equip-skin="' + skin['id'] + '"]').click()
                check(profile(page)['selectedSkin'] == skin['id'], 'Görünüm seçilmedi')
                page.reload()
                page.wait_for_function('() => !!window.mt3dApp')
                check(profile(page)['selectedSkin'] == skin['id'], 'Görünüm yeniden açılışta kayboldu')
                log.assert_clean('gardırop')

                # Eski kayıt formatıyla uyumlu, kazanılmasına tek kare kalan gerçek bir tarla.
                fixture = {'v': 1, 'mode': 'kampanya', 'stage': 0, 'runId': 'qa-complete-once',
                           'cfg': {'w': 8, 'd': 8, 'm': 8, 'theme': 'meadow'},
                           'grid': {'mines': list(range(8)), 'revealed': [i for i in range(8, 64) if i != 18], 'flags': [], 'craters': []},
                           'start': {'x': 3, 'z': 3}, 'player': {'x': 1, 'z': 2, 'dir': [1, 0]},
                           'lives': 3, 'charges': 3, 'elapsed': 12}
                rewards_context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
                rewards_context.add_init_script('localStorage.setItem("mt3d-v1-save", ' + json.dumps(json.dumps(fixture)) + ');')
                reward_page = rewards_context.new_page()
                reward_log = RuntimeLog(reward_page, origin, True)
                coins = None
                for attempt in range(2):
                    reward_page.goto(origin) if attempt == 0 else reward_page.reload()
                    reward_page.wait_for_function('() => !!window.mt3dApp')
                    reward_page.locator('#continueBtn').tap()
                    reward_page.locator('[data-dir="right"]').tap()
                    reward_page.wait_for_function("() => document.querySelector('#toast').textContent.includes('Bilinmeyen kare')")
                    reward_page.locator('[data-dir="right"]').tap()
                    reward_page.locator('#msg.show').wait_for()
                    earned = profile(reward_page)['coins']
                    if attempt == 0:
                        check(earned > 0, 'İlk görev ödülü verilmedi')
                        coins = earned
                    else:
                        check(earned == coins, 'Aynı koşu tekrar ödül verdi')
                    check(reward_page.evaluate("JSON.parse(localStorage.getItem('mt3d-v1-unlocked'))") >= 1, 'Sonraki görev açılmadı')
                reward_log.assert_clean('gerçek görev bitişi ve ödül idempotansı')
                print(f'PASS mobil deneyim: 24 görev, 8 adımlı eğitim, ayarlar, sabit günlük tarla, gardırop, gerçek kazanma/tek ödül ({time.monotonic() - started:.1f}s)')
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(f'FAIL mobil deneyim: {error}', file=sys.stderr)
        raise
