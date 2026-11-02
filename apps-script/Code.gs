// ============================================================
// 스트리머 캘린더용 Google Apps Script 웹앱
// - 이 스크립트를 스프레드시트에 연결해서 배포하면, 캘린더 페이지가
//   이 URL로 요청을 보내서 시트에 값을 "쓸" 수 있게 됩니다.
// - 구글 시트 CSV 내보내기는 읽기 전용이라, 쓰기에는 이 방법이 필요합니다.
// - 응답에 CORS 헤더가 안 붙어서 캘린더 페이지는 no-cors로 요청을 보내고
//   응답 내용을 읽지 못합니다. 그래서 무슨 일이 있었는지 진단할 수 있게,
//   SETTINGS 시트의 G1 셀에 마지막 처리 결과를 항상 기록해둡니다.
//   (문제 없으면 신경 안 쓰셔도 되는 칸입니다)
// ============================================================

var SETTINGS_GID = '1577649692'; // 메인컬러/서브컬러/캘린더제목/배경이미지URL/관리자비밀번호
var SCHEDULE_GID = '1998787329';  // 날짜/카테고리/내용
var DEBUG_CELL = 'G1';            // 설정 시트에서 마지막 처리 결과를 기록할 칸

function getSheetByGid(gid) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getSheetId()) === String(gid)) return sheets[i];
  }
  return null;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function writeDebug(message) {
  try {
    var settingsSheet = getSheetByGid(SETTINGS_GID);
    if (settingsSheet) {
      settingsSheet.getRange(DEBUG_CELL).setValue(
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') + ' - ' + message
      );
    }
  } catch (e) {
    // 디버그 기록 자체가 실패해도 본 기능에는 영향 없게 무시
  }
}

// 셀 값이 Date 객체든(시트가 날짜로 자동 인식한 경우) 문자열이든
// 항상 "YYYY-MM-DD" 형태의 문자열로 통일해서 비교할 수 있게 한다.
function cellToDateString(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function doPost(e) {
  // 여러 요청이 거의 동시에 들어오면(예: 여러 일정을 빠르게 연달아 추가/삭제),
  // 각자 "지금 시트가 몇 줄인지"를 따로 읽어서 처리하다가 서로 엇갈려 엉뚱한
  // 행을 지우거나 겹쳐 쓸 수 있다. LockService로 한 번에 한 요청씩만 실제
  // 시트를 건드리게 줄 세운다 (대기는 최대 30초, 그래도 안 풀리면 에러 처리).
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    writeDebug('실패 - 다른 요청 처리 중이라 30초 내에 순서를 못 받음');
    return jsonResponse({ ok: false, error: 'busy, try again' });
  }

  try {
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      writeDebug('실패 - 잘못된 JSON: ' + err.message);
      return jsonResponse({ ok: false, error: 'invalid JSON' });
    }

    var settingsSheet = getSheetByGid(SETTINGS_GID);
    if (!settingsSheet) return jsonResponse({ ok: false, error: 'settings sheet not found' });

    // 관리자비밀번호(설정 시트 2행 5번째 칸)와 대조 — 캘린더 페이지에 로그인한
    // 비밀번호와 동일한 값을 매 요청마다 같이 보내오게 되어 있다.
    var storedPassword = String(settingsSheet.getRange(2, 5).getValue() || '').trim();
    if (!storedPassword || body.password !== storedPassword) {
      writeDebug('실패 - 비밀번호 불일치 (action=' + body.action + ')');
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    if (body.action === 'updateSettings') {
      // A2:D2 = 메인컬러, 서브컬러, 캘린더제목, 배경이미지URL (5번째 비밀번호 칸은 건드리지 않음)
      settingsSheet.getRange(2, 1, 1, 4).setValues([[
        body.mainColor || '',
        body.subColor || '',
        body.calTitle || '',
        body.bgImageUrl || '',
      ]]);
      // J2 = 상단 띠 말풍선 문구("♡ 오늘도 함께해요" 자리).
      // 문자열로 올 때만 쓴다 (비워서 보내면 칸이 비워지고, 캘린더 페이지는 기본 문구로 되돌아간다).
      if (typeof body.heroTag === 'string') {
        settingsSheet.getRange(2, 10).setValue(body.heroTag);
      }
      writeDebug('성공 - updateSettings');
      return jsonResponse({ ok: true });
    }

    if (body.action === 'addSchedule') {
      var scheduleSheet = getSheetByGid(SCHEDULE_GID);
      if (!scheduleSheet) return jsonResponse({ ok: false, error: 'schedule sheet not found' });
      scheduleSheet.appendRow([body.date || '', body.category || '', body.text || '']);
      writeDebug('성공 - addSchedule (' + body.date + ', ' + body.category + ', ' + body.text + ')');
      return jsonResponse({ ok: true });
    }

    if (body.action === 'deleteSchedule') {
      var scheduleSheet2 = getSheetByGid(SCHEDULE_GID);
      if (!scheduleSheet2) return jsonResponse({ ok: false, error: 'schedule sheet not found' });

      var targetDate = String(body.date || '').trim();
      var targetCategory = String(body.category || '').trim();
      var targetText = String(body.text || '').trim();

      // 행 번호가 아니라 (날짜, 카테고리, 내용) 값이 정확히 일치하는 첫 번째 행을
      // 찾아서 지운다. 날짜 칸이 시트에서 자동으로 "날짜" 형식이 됐을 수 있어서
      // cellToDateString으로 항상 문자열로 통일해서 비교한다.
      var data = scheduleSheet2.getDataRange().getValues();
      for (var r = 1; r < data.length; r++) { // r=0은 헤더 행이므로 건너뜀
        var rowDate = cellToDateString(data[r][0]);
        var rowCategory = String(data[r][1] || '').trim();
        var rowText = String(data[r][2] || '').trim();
        if (rowDate === targetDate && rowCategory === targetCategory && rowText === targetText) {
          scheduleSheet2.deleteRow(r + 1); // 시트 행 번호는 1부터 시작
          writeDebug('성공 - deleteSchedule, 시트 행 ' + (r + 1) + '번 삭제 (' + targetDate + ', ' + targetCategory + ', ' + targetText + ')');
          return jsonResponse({ ok: true });
        }
      }
      writeDebug(
        '실패 - deleteSchedule, 일치하는 행을 못 찾음. 찾던 값=[' + targetDate + ', ' + targetCategory + ', ' + targetText + ']' +
        ' / 실제 첫 데이터 행=[' + (data[1] ? cellToDateString(data[1][0]) + ', ' + data[1][1] + ', ' + data[1][2] : '없음') + ']'
      );
      return jsonResponse({ ok: false, error: 'row not found' });
    }

    if (body.action === 'updateSheetPointer') {
      // F~I열(6~9번째 칸) = 연결대상 스프레드시트ID / 설정탭gid / 일정탭gid / AppsScriptURL
      // 4칸 모두 비우면(초기화) 캘린더는 이 시트 자신을 기본값으로 사용한다.
      settingsSheet.getRange(2, 6, 1, 4).setValues([[
        body.spreadsheetId || '',
        body.settingsGid || '',
        body.scheduleGid || '',
        body.appsScriptUrl || '',
      ]]);
      writeDebug('성공 - updateSheetPointer (' + (body.spreadsheetId || '기본값으로 초기화') + ')');
      return jsonResponse({ ok: true });
    }

    writeDebug('실패 - 알 수 없는 action: ' + body.action);
    return jsonResponse({ ok: false, error: 'unknown action' });
  } catch (fatalErr) {
    // 여기까지 오면 예상 못 한 예외 — 원인을 반드시 디버그 칸에 남긴다
    writeDebug('치명적 오류: ' + fatalErr.message + ' / ' + fatalErr.stack);
    return jsonResponse({ ok: false, error: 'internal error: ' + fatalErr.message });
  } finally {
    lock.releaseLock();
  }
}

// 브라우저에서 URL을 직접 열어봤을 때 안내 메시지 (디버깅용)
function doGet(e) {
  return jsonResponse({ ok: false, error: 'This endpoint only accepts POST requests.' });
}
