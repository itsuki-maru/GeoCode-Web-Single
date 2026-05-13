#!/bin/bash

# 事前に /usr/local/bin にバイナリを配置しておく

# axumサーバーを起動（最初のプロセスだけが-iオプションにより初期データの作成を試みる）
geocode_web_loca -h localhost -p 3001 &
sleep 1
geocode_web_loca -h localhost -p 3002 &
sleep 1
geocode_web_loca -h localhost -p 3003 &
sleep 1
geocode_web_loca -h localhost -p 3004 &

# 全てのバックグラウンドプロセスが終了するまで待機
wait