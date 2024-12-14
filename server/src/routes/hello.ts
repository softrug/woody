import { Router, Request, Response, NextFunction } from "express";

const router = Router();

//middleware to check that NODE_ENV is only local development
const checkNodeEnv = (_req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV !== "development") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
};

//handles the collabland api token creation in .env
const handlePostCollabLand = async (_req: Request, res: Response) => {
  console.log("Getting hello Collab-thon...");
  res.status(200).json({
    message: "Hello Collab-thon",
    timestamp: new Date().toISOString(),
  });
};

router.get("/collabland", checkNodeEnv, handlePostCollabLand);

export default router;
