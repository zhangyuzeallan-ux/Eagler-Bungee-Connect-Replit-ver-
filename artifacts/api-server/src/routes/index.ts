import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bungeeRouter from "./bungee";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bungeeRouter);

export default router;
