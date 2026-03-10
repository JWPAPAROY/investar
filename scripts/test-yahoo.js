(async () => {
    const yahooFinance = (await import('yahoo-finance2')).default;
    try {
        const res = await yahooFinance.quote('^KS200');
        console.log("Yahoo ^KS200:", JSON.stringify(res, null, 2));
    } catch (e) {
        console.log("Yahoo ^KS200 failed:", e.message);
    }
})();
