package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:            "Proxy Master",
		Width:            1200,
		Height:           800,
		MinWidth:         800,
		MinHeight:        600,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
		OnStartup:        app.startup,
		OnShutdown: func(ctx context.Context) {
			app.cleanup()
		},
		Bind: []interface{}{app},
		// 添加錯誤處理
		OnDomReady: func(ctx context.Context) {
			// DOM 準備好後執行
		},
		// 禁用窗口框架，使用自定義標題欄
		Frameless: true,
		// 啟用透明
		CSSDragProperty: "--wails-draggable",
		CSSDragValue:    "drag",
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
