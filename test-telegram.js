require('dotenv').config();

async function sendTestMessage() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    console.log('BOT_TOKEN:', token ? '✅ 설정됨' : '❌ 없음');
    console.log('CHAT_ID:', chatId ? '✅ 설정됨' : '❌ 없음');

    if (!token || !chatId) {
        console.log('❌ 텔레그램 설정이 없습니다.');
        return;
    }

    const message = `🧪 <b>Investar 테스트 메시지</b>

✅ 텔레그램 연동 정상 작동 중!
📅 ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}

🔗 https://investar-xi.vercel.app`;

    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });

        const result = await response.json();
        if (result.ok) {
            console.log('✅ 텔레그램 메시지 전송 성공!');
        } else {
            console.log('❌ 전송 실패:', result.description);
        }
    } catch (error) {
        console.error('❌ 오류:', error.message);
    }
}

sendTestMessage();
