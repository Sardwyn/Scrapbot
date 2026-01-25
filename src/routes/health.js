import express from 'express';
const router = express.Router();
router.get('/auth/kick/health', (req,res)=>res.json({ok:true, service:'scrapbot', ts:Date.now()}));
export default router;
