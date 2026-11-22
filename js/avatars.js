/*
    avatars.js: the pre-drawn avatars people can pick in their profile (16 x 16 pixies, see nes.js).
    Anyone can also draw their own, or keep the random critter made from their user id.
*/
export const PRESET_AVATARS = [
    {
        id: "pixie",
        name: "Pixie",
        pixels: ".................dd..........dd.dNNd..dddd..dNNddNMNddBBBBddNMNddNNNdBQQBBBdNNNd.dNdBBQBBBBBdNd..dNdBBdBBdBBdNd...ddBBdBBdBBdd.....dlBBBBBBld......dBBdBBdBBd.......dBBddBBd.........ddBBdd..E........dBBd..EME...E..dd..dd..E.................................."
    },
    {
        id: "cat",
        name: "Cat",
        pixels: "..................d..........d...dDd........dDd..dDDd......dDDd..dDRDddddddDRDd..dDDDDDDDDDDDDd.dDDDDDDDDDDDDDDddDDdMdDDDDdMdDDddDDdddDDDDdddDDddBBDDDDddDDDDBBddDDDDDDDDDDDDDDd.dDDDDdDDdDDDDd...dDDDDddDDDDd.....ddDDDDDDdd........dddddd....................."
    },
    {
        id: "bunny",
        name: "Bunny",
        pixels: "...................dd......dd.....dMMd....dMMd....dMRd....dRMd....dMRd....dRMd....dMRddddddRMd....dMMMMMMMMMMd...dMMMMMMMMMMMMd..dMMdMMMMMMdMMd..dMMdMMMMMMdMMd..dRMMMMddMMMMRd..dMMMMdRRdMMMMd...dMMMMMMMMMMd.....ddMMMMMMdd........dddddd....................."
    },
    {
        id: "frog",
        name: "Frog",
        pixels: "..................dddd....dddd...dMMMMd..dMMMMd..dMddMddddMddMd..dMddMqqqqMddMd.ddqMMqqqqqqMMqdddqqqqqqqqqqqqqqddqqqqqqqqqqqqqqddqRqqqqqqqqqqRqddqqdqqqqqqqqdqqddqqqddddddddqqqd.dqqqqqqqqqqqqd...ddqqqqqqqqdd......dddddddd...................................."
    },
    {
        id: "robot",
        name: "Robot",
        pixels: ".......dd.............dmmd.............dd.........dddddddddddd....dwwwwwwwwwwd...ddwdddwwdddwdd..dgwdxdwwdxdwgd..dgwdddwwdddwgd..ddwwwwwwwwwwdd...dwwddddddwwd....dwwdEdEdEwwd....dwwddddddwwd....dwwwwwwwwwwd....dddddddddddd.................................."
    },
    {
        id: "alien",
        name: "Alien",
        pixels: ".....................dddddd........ddFFFFFFdd.....dFFFFFFFFFFd...dFFFFFFFFFFFFd..dFdddFFFFdddFd..ddddddFFdddddd..ddMdddFFdddMdd..dFdddFFFFdddFd...dFFFFFFFFFFd.....dFFFddFFFd.......dFFFFFFd.........dddddd....................................................."
    },
    {
        id: "strawberry",
        name: "Strawberry",
        pixels: ".......qq............qqaaqq.........qaaqqaaq.......ddqqqqqqdd.....dmmmmmmmmmmd...dmmUmmmmmUmmmd..dmmmmmUmmmmmmd..dmUmmmmmmmUmmd..dmmmmUmmmmmmmd...dmmmmmmmUmmd....dmUmmmmmmmmd.....dmmmUmmmmd.......dmmmmmUd.........dmmmmd...........dddd......................"
    },
    {
        id: "heart",
        name: "Heart",
        pixels: "...................................dddd..dddd.....dmmmmddmmmmd...dmMMmmmmmmmmmd..dmMmmmmmmmmmmd..dmmmmmmmmmmmmd..dmmmmmmmmmmm6d...dmmmmmmmmm6d.....dmmmmmmm6d.......dmmmmm6d.........dmmm6d...........dm6d.............dd......................................."
    },
    {
        id: "rocket",
        name: "Rocket",
        pixels: ".......dd.............dMMd...........dMMMwd..........dMMMwd.........dMMNNMwd........dMNxxNwd........dMNxxNwd........dMMNNMwd........dMMMMMwd......dmdMMMMMwdmd...dmmdMMMMMwdmmd..dmmddddddddmmd..ddd.dDEEDd.ddd.......dEEd.............dd......................."
    },
    {
        id: "potion",
        name: "Potion",
        pixels: "......dddd............d77d............dddd.............dd..............dd.............dNNd...........dNNNNd.........dNkkkkNd.......dkkAkkkkkd......dkAMAkkkkd......dkkAkkkkkd......dkkkkkkkzd......dkkkkkkzzd.......dkkkkzzd.........dddddd....................."
    },
    {
        id: "cactus",
        name: "Cactus",
        pixels: ".......dd.............dqqd............dqFd........dd..dqFd.......dqFd.dqFd..dd...dqFd.dqFd.dqFd..dqFdddqFd.dqFd..dqFFFFqFdddqFd...ddqqqqFFFFqFd.....dddqFqqqqd........dqFdddd.........dqFd..........dddddddd........dCCCCCCd.........dSSSSd..........dddddd....."
    },
    {
        id: "planet",
        name: "Planet",
        pixels: ".....................dddddd........ddzzzzjjdd.....dzzMzzzzjjjd...dzzzzzzzzzjjd..dddddzzzzzzjjjd.dUUUUddddzzjjjdd.ddUUUUUUddddUUd..djdddUUUUUUUd...djjjjddddddd.....ddjjjjjjdd........dddddd......................E............E.EME..........EME.E............E."
    }
];
