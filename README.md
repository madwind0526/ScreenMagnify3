# ScreenMagnify3

화면을 확대해 보는 Windows 도구입니다 (Electron). [ScreenMagnify](https://github.com/madwind0526/ScreenMagnify)와 [ScreenMagnify2](https://github.com/madwind0526/ScreenMagnify2)를 하나로 합쳤고, 설정에서 모드를 고릅니다. 보간은 일반 필터부터 AI 초해상도(Real-ESRGAN, 4xNomosUni)까지 고를 수 있고, 모두 내 PC에서만 처리됩니다.

앱 안의 글자는 한국어이고, 코드 주석은 영어입니다.

## 모드

| 모드 | 동작 |
|---|---|
| 1: 선택 캡처 (ScreenMagnify) | 사각형, 원형, 자유 모양으로 영역을 고르면 결과 창에서 확대(0.5~64배)하고 PNG로 저장 |
| 2: 돋보기 (ScreenMagnify2) | 마우스를 따라다니는 돋보기로 화면(정지 또는 실시간)을 확대 |

설정에서 현재 모드에 해당하지 않는 항목은 회색으로 비활성화됩니다 (모드 2에서는 자유 모양과 multi 화면, 모드 1에서는 돋보기 항목).

## 단축키

| 키 | 동작 |
|---|---|
| Ctrl + W | 모드 1로 바꾸고 바로 선택 캡처 시작 (어느 창에 있든) |
| Ctrl + Q | 모드 2로 바꾸고 바로 돋보기 시작 (어느 창에 있든) |
| Ctrl + 1 / Ctrl + 2 | 모드만 바꿈 (이 앱 창에 포커스가 있을 때) |
| Ctrl + Enter | 현재 모드로 실행 (이 앱 창에 포커스가 있을 때) |

Ctrl+Q/W는 앱이 떠 있고 최소화/숨김 상태가 아닐 때만 다른 프로그램에서 가져갑니다. ScreenMagnify, ScreenMagnify2와 동시에 실행하면 키가 겹칩니다.

사용법과 모드별 키(휠, Ctrl+휠, Ctrl+S 등)는 각 원본 프로젝트의 README와 같습니다.

## 실행

```
npm install
npm start
npm run dist   # release/ScreenMagnify3-<version>.zip
```

Windows 10/11 (64-bit). GPU 옵션은 DirectX 12 GPU가 필요합니다. 설정은 `%APPDATA%\screenmagnify3`에 저장됩니다.

## 라이선스

MIT. AI 모델(`models/`)은 각 원 저작자의 라이선스를 따릅니다.
