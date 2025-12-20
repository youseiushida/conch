1. PowerShell環境でPowerShellをconch経由で起動して使えるか確認
2. PowerShell環境でWSLをconch経由で起動して使えるか確認
3. WSL環境でBashをconch経由で起動して使えるか確認
4. Windows環境でcmd.exeをconch経由で起動して使えるか確認
5. Windows環境でGit Bashをconch経由で起動して使えるか確認
6. macOS環境でBashをconch経由で起動して使えるか確認
7. macOS環境でzshをconch経由で起動して使えるか確認
8. Linux環境でBashをconch経由で起動して使えるか確認

## Shell Integration関連

9. PowerShell環境でShell Integration (OSC 133) が正しく動作するか確認
10. WSL環境でShell Integration (OSC 133) が正しく動作するか確認
11. Shell Integrationが有効な状態で`run()`メソッドがコマンド完了を正確に検知できるか確認

## 文字エンコーディング関連

12. Windows環境でUTF-8文字（日本語、絵文字等）が正しく表示・入力できるか確認
13. WSL環境でUTF-8文字が正しく表示・入力できるか確認
14. Windows環境で`chcp 65001`が自動実行され、文字化けが発生しないか確認

## 機能・操作関連

15. 端末サイズ変更（`resize()`）が各環境で正しく動作するか確認
16. TUIアプリケーション（vim、htop等）の操作が各環境で可能か確認
17. 特殊キー入力（Ctrl+C、Esc、矢印キー等）が各環境で正しく動作するか確認
18. `waitForText`、`waitForStable`等の待機ユーティリティが各環境で正しく動作するか確認

## エッジケース

19. 非常に長い出力（スクロールバッファ）が正しく処理できるか確認
20. 複数のConchセッションを同時に実行できるか確認
21. プロセスが異常終了した場合のエラーハンドリングが正しく動作するか確認