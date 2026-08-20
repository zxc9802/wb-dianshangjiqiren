import VideoWorkbenchClient from '../video-workbench/VideoWorkbenchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function TikTokStudioPage() {
    return <BotAccessGate botKey="tiktok-studio"><VideoWorkbenchClient site="tiktok" /></BotAccessGate>;
}
