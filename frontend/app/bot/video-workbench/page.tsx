import VideoWorkbenchClient from './VideoWorkbenchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function VideoWorkbenchPage() {
    return <BotAccessGate botKey="video-workbench"><VideoWorkbenchClient site="seedance" /></BotAccessGate>;
}
